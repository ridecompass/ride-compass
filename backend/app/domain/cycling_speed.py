"""自転車の走行モデル（所要時間の物理）。

区間ごとの速度は走行方程式で決まる:

    ホイール出力 P = ( 空気抵抗 + 転がり抵抗 + 重力 ) × 速度
    空気抵抗 = ½ × ρ × CdA × (速度 + 向かい風)²   （ρ は区間の標高と予報の気温の空気密度）
    転がり抵抗 = Crr × 質量 × g
    重力     = 質量 × g × 勾配

利用者から取る入力は**平地・無風の巡航速度**だけで、そこからホイール出力を逆算する
（`wheel_power_w`）。体重・出力・ケイデンスは一般の利用者が答えられないため、CdA・Crr・質量は
全員に共通の較正値（`domain/tuning.py`の宣言。走ってみて決める値）を使う。坂・向かい風・路面で抵抗が増えると、同じ決まりで踏み増す（`_pushed_power`）。「向かい風に強い／弱い」の差の
多くは巡航速度の違いとして式から出る。

**駆動系の伝達効率は掛けない**。巡航速度から逆算するのはホイールでの出力で、他の条件でも
同じ量を使うため相殺される。

速度の逆算は`v`の3次方程式になるため二分法で解く（`SegmentSpeedModel`、区間の断面の点の間ごとのループをnumbaでJITする）。
探索中には呼ばず、コスト配列を合成するときに区間ごと（風は時刻ビンごと）へ事前計算する。

**1本の区間の中では勢いを持ち越す**（Martin ら 1998 の運動エネルギーの変化の項 ½m(v_f² − v_i²)）。点の間を走る順に速さを
進め（`_carried_spans`）、今の速さがその点の間の釣り合いの速さ（上の式で解いた、坂・風・路面で踏み増したときの速さ）より速い
間は平地の出力のまま踏み増さず、釣り合いの速さまで落ちたら踏み増してその速さを保つ——長い坂は釣り合いの速さと体力のまま、
区間の中の短い上り下りは勢いで越えて踏み増さない。持ち越さないと、上りの点の間の踏み増しだけが体力に積まれ、下りでは戻らない
ので、標高の小さな揺れや区間の中の短い上り下りを重く数える。
勢いを引き継がない点の間（`ProfileSpans.carries`が偽。どれがそうかは`domain/elevation_profile.py: flatten_spans`が決める）は、
釣り合いの速さで走り、そこから先の勢いをその速さで始める。区間の最初の点の間は引き継がないので、区間をまたいでは持ち越さない
（探索は区間ごとに費用を前もって持つ）。
"""

from dataclasses import dataclass

import numpy as np
from numba import njit

from app.domain.attributes import CategoricalColumn
from app.domain.elevation_profile import ProfileSpans
from app.domain.road_classes import RoadClassDefinitions, class_material_id
from app.domain.search_graph import kernel_array, range_positions
from app.domain.traffic import stop_count_material_ids
from app.domain.tuning import BASE_CRR_ID, RIDER_HEIGHT_ID, Tuning, require_tuning
from app.domain.wind import drag_increases_m2_s2, kmh_to_ms
from app.domain.wind_height import FORECAST_HEIGHT_M

_GRAVITY_M_S2 = 9.80665

#: 予報を使わない計算で解く気温（℃）。標準大気の海面の気温で、平地の出力の逆算もこの気温・標高0mの空気で行う。
STANDARD_TEMPERATURE_C = 15.0


def _air_pressure_kpa(elevation_m):
    """標高（m）の気圧（kPa）。NASA Glenn Research Center "Earth Atmosphere Model" の対流圏（11,000m 未満）の式で、標準の
    気温の減り方から出す。"""
    return 101.29 * ((15.04 - 0.00649 * elevation_m + 273.1) / 288.08) ** 5.256


def _air_density_kg_m3(pressure_kpa, temperature_c):
    """気圧（kPa）と気温（℃）の空気密度（kg/m³）。同じ文書の ρ = p / (0.2869 × (T + 273.1))。"""
    return pressure_kpa / (0.2869 * (temperature_c + 273.1))


#: 平地の出力を逆算する空気（標高0m・`STANDARD_TEMPERATURE_C`）の密度。乗り手の出力は人の側で決まり、空気の濃さでは
#: 変えない——同じ出力で、空気が薄い所・暑い日は速く、濃い所・寒い日は遅く走る。
_STANDARD_AIR_DENSITY_KG_M3 = _air_density_kg_m3(_air_pressure_kpa(0.0), STANDARD_TEMPERATURE_C)

# 走ってみて決める値（CdA・Crr・質量・速度の上下限・登りの出力の増え方等）は
# `domain/tuning.py`が宣言し、ここでは読むだけにする。定数として持つと、宣言と二重に
# なったうえ管理画面からの変更が効かない。

# 速度を挟み込む二分法の反復回数。初期区間は押して歩く速度〜速度の上限（`top_speed_kmh`。巡航速度の上限は
# `domain/route_request.py: MAX_ASSUMED_SPEED_KMH`）で、12回で幅は初期区間の4096分の1（巡航速度が上限でも0.01km/h程度）まで縮む。粗くすると平地・無風で巡航速度に一致しなくなる。
_SPEED_SOLVE_ITERATIONS = 12

#: 区間ごとに速度を変える道と天気の条件の、画面で呼ぶ名前（走行方程式の重力・空気抵抗・転がり抵抗の順）。
#: 方程式に条件を足したら、ここにも足す。
SEGMENT_SPEED_CONDITIONS: tuple[str, ...] = ("坂", "風", "気温", "標高", "路面")

#: 利用者が入れる巡航速度が何の速さかを、利用者に言う名前（出力を逆算する条件、`wheel_power_w`）。
CRUISE_SPEED_LABEL = "平地・無風で巡航する速さ"


def travel_model_wording(tuning: Tuning) -> str:
    """巡航速度から区間の速度を決める決まりを、`tuning`の較正値を入れて利用者に言う文。"""
    return (
        "所要時間は、次のように計算します。\n"
        f"・平地・無風[気温{STANDARD_TEMPERATURE_C:g}℃・海面の空気]をこの速度で走る力を求めます。\n"
        f"・区間ごとの{'・'.join(SEGMENT_SPEED_CONDITIONS)}に合わせて、速度を変えます。\n"
        f"・風は、予報の地上{FORECAST_HEIGHT_M:g}mの風を、道の周りの土地被覆から乗り手の高さ[{tuning.value(RIDER_HEIGHT_ID):g}m]の風へ直して使います。\n"
        f"・体格と機材は標準の値です。総質量は{tuning.value('speed.mass_kg'):g}kg[体重・車体・装備の合計]です。\n"
        f"・空気抵抗CdAは{tuning.value('speed.cda_m2'):g}m²[ロードバイクでブラケットを握る姿勢]です。\n"
        f"・下りは{tuning.value('speed.max_descent_kmh'):g}km/hまで出します[想定速度のほうが速ければ想定速度まで]。\n"
        f"・登りで{tuning.value('speed.walking_kmh'):g}km/h以下になる所は、押して歩くとみなします。"
    )

def rolling_resistance_material_id(road_classes: RoadClassDefinitions) -> str | None:
    """走行モデルが転がり抵抗に読む区分の列の材料id（転がり抵抗の表が指す分け方。指していなければNone）。"""
    key = road_classes.rolling_resistance_classification
    return class_material_id(key) if key is not None else None


def travel_model_material_ids(road_classes: RoadClassDefinitions) -> tuple[str, ...]:
    """所要時間（走行方程式の路面と、停止の待ち）が区間ごとに読む材料id。勾配は材料ではなく区間の断面の点から読む
    （`domain/elevation_profile.py`）。

    探索の材料の表はこれらを**費用の軸の構成と無関係に**列として運び、欠けた表は組み立てで断る
    （`search_materials.py: build_search_materials`）。軸が分解した材料だけを運ぶ既定に任せると、その軸を
    非公開にした瞬間に所要時間から路面・停止の待ちが静かに消える。
    """
    rolling = rolling_resistance_material_id(road_classes)
    return (*((rolling,) if rolling is not None else ()), *stop_count_material_ids())


def crr_for_surface(rolling_classes: CategoricalColumn, road_classes: RoadClassDefinitions, tuning: Tuning) -> np.ndarray:
    """路面の見込み（転がり抵抗の表が指す分け方の区分）から、区間ごとの転がり抵抗を返す。

    区分の外の道・表に無い区分は、基準の転がり抵抗（`RiderProfile.crr`）にする。
    """
    ids = road_classes.rolling_resistance_classes.get(road_classes.rolling_resistance_classification or "", {})
    table = {key: tuning.value(tuning_id) for key, tuning_id in ids.items()}
    crr = rolling_classes.lookup(table)
    return np.where(np.isnan(crr), tuning.value(BASE_CRR_ID), crr)


@dataclass(frozen=True)
class RiderProfile:
    """走行モデルの個人パラメータ。利用者が入力するのは巡航速度だけで、残りは全員に共通の較正値。"""

    cruise_speed_kmh: float
    cda_m2: float
    crr: float
    mass_kg: float

    @classmethod
    def standard(cls, cruise_speed_kmh: float, tuning: Tuning) -> "RiderProfile":
        """巡航速度`cruise_speed_kmh`の人。体格と機材は較正値。"""
        return cls(cruise_speed_kmh=cruise_speed_kmh, cda_m2=tuning.value("speed.cda_m2"), crr=tuning.value(BASE_CRR_ID),
                   mass_kg=tuning.value("speed.mass_kg"))

    @property
    def cruise_speed_ms(self) -> float:
        return kmh_to_ms(self.cruise_speed_kmh)


def wheel_power_w(profile: RiderProfile) -> float:
    """平地・無風・標準の空気（`_STANDARD_AIR_DENSITY_KG_M3`）の巡航速度からホイール出力（W）を逆算する。"""
    speed = profile.cruise_speed_ms
    drag = 0.5 * _STANDARD_AIR_DENSITY_KG_M3 * profile.cda_m2 * speed * speed
    rolling = profile.crr * profile.mass_kg * _GRAVITY_M_S2
    return (drag + rolling) * speed


@njit(cache=True, nogil=True)
def _pushed_power(flat_power_w: float, power_per_force: float, max_ratio: float,
                  extra_force_n: float) -> tuple[float, float]:
    """抵抗が平地より`extra_force_n`（N。負なら平地より楽）増えたときに、踏みたい出力と実際に踏む出力（W）。JITのループから
    呼ぶので、増えた抵抗1Nあたりの踏み増し`power_per_force`（W/N）と上限倍率`max_ratio`は呼び手が決めて渡す。

    踏みたい出力は、増えた抵抗1Nごとに`power_per_force`のWを平地の出力へ足したもの。坂の重力も
    向かい風の空気抵抗も路面の転がり抵抗も、同じ決まりで踏み増す。抵抗が平地より減る区間（下り・追い風）は平地の出力のまま
    （減らさない）。実際に踏む出力は、踏みたい出力を平地の出力の上限倍率で止めたもの。

    一定出力で計算すると平地20km/hの人が勾配5%で時速4.6km＝押して歩く速度になり現実と合わないため、抵抗に比例して
    踏む量を増やす。足す量を平地の出力に比例させない——比例させると巡航が速い人ほど登りで踏み増し、坂でも平地並みの
    速度を保って所要時間が短く出る。
    """
    desired = flat_power_w + power_per_force * max(extra_force_n, 0.0)
    return desired, min(desired, flat_power_w * max_ratio)


def kickoff_extra_j(profile: RiderProfile, tuning: Tuning) -> float:
    """止まる出来事1回の漕ぎ出しで、平地の出力を越えて踏む体力（J）。止まった所から巡航速度まで、平地の出力の上限倍率
    （`speed.max_climb_power_ratio`）で踏んで加速する前提で、要る運動エネルギー½mv²のうち平地の出力を越えた分
    （1 − 1/上限倍率）。"""
    speed = profile.cruise_speed_ms
    return 0.5 * profile.mass_kg * speed * speed * (1.0 - 1.0 / tuning.value("speed.max_climb_power_ratio"))


def top_speed_kmh(cruise_speed_kmh: float, tuning: Tuning) -> float:
    """区間の速度の上限。下りの上限か、それより速ければ巡航速度。

    下りの上限だけで止めると、それより速い巡航速度を入れた人が平地・無風でも上限で頭打ちになり、
    入れた速度が所要時間に効かない。
    """
    return max(tuning.value("speed.max_descent_kmh"), cruise_speed_kmh)


#: `SegmentSpeedModel`がJITへ渡す、乗り手と較正値の数の並び（1本のfloat32の配列で渡す）。
_RIDER_WEIGHT, _RIDER_FLAT_POWER, _RIDER_BASE_CRR, _RIDER_POWER_PER_FORCE, _RIDER_MAX_RATIO, _RIDER_HALF_CDA, _RIDER_LOWEST, \
    _RIDER_HIGHEST, _RIDER_CRUISE = range(9)


@njit(cache=True, nogil=True)
def _span_static(span_row: np.ndarray, span_grade: np.ndarray, crr: np.ndarray,
                 rider: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """点の間ごとの、風に依らない`(速度に依らない抵抗（転がり＋重力、N）, 平地・基準の路面より増えた重力と転がり抵抗（N）)`。"""
    weight = rider[_RIDER_WEIGHT]
    base_crr = rider[_RIDER_BASE_CRR]
    constant_force = np.empty(len(span_row), dtype=np.float32)
    static_extra = np.empty(len(span_row), dtype=np.float32)
    for i in range(len(span_row)):
        crr_here = crr[span_row[i]]
        gravity = weight * span_grade[i]
        constant_force[i] = crr_here * weight + gravity
        static_extra[i] = gravity + (crr_here - base_crr) * weight
    return constant_force, static_extra


@njit(cache=True, nogil=True)
def _resistance_n(speed: float, constant_force: float, headwind: float, cross_squared: float, drag: float) -> float:
    """速さ`speed`で走るときの抵抗力（N）。空気抵抗は相対風速の大きさ×進行方向の相対風速に比例し（横風は大きさにだけ効く）、
    `constant_force`は速さに依らない抵抗（転がり＋重力）。釣り合いの速さを解くfloat32と、勢いを解くfloat64の両方から呼ぶ。"""
    along = speed + headwind
    return np.sqrt(along * along + cross_squared) * along * drag + constant_force


@njit(cache=True, nogil=True)
def _span_speeds(span_row: np.ndarray, constant_force: np.ndarray, static_extra: np.ndarray, air_extra_n: np.ndarray,
                 headwind_ms: np.ndarray, crosswind_ms: np.ndarray, drag: np.ndarray,
                 rider: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """点の間ごとの`(速度（m/s）, 実際に踏む出力（W）)`。踏む出力は`_pushed_power`の決まり、速度は走行方程式
    `P = 抵抗力(v) × v`を二分法で解いたもの（3次方程式。ニュートン法は抵抗力が0を跨ぐ下り坂で発散しうるため、区間を
    確実に狭める方を採る）。`drag`は区間の行ごとの空気抵抗の係数 ½ρCdA。

    **演算はすべてfloat32で、1つずつ丸める**（numbaは`fastmath`を立てなければ演算をまとめない）。float32の有効桁は
    7桁で、二分法が詰める幅（0.003m/s）より4桁細かい。"""
    flat_power = rider[_RIDER_FLAT_POWER]
    per_force = rider[_RIDER_POWER_PER_FORCE]
    max_ratio = rider[_RIDER_MAX_RATIO]
    lowest = rider[_RIDER_LOWEST]
    highest = rider[_RIDER_HIGHEST]
    half = np.float32(0.5)
    spans = len(span_row)
    # 区間の行の風を点の間へ配るループと、解くループを分ける——解くループが並びを順に読むだけになり、CPUが複数の点の間を
    # まとめて計算できる（行を引いて読むと、まとめられず数倍遅い）。
    powers = np.empty(spans, dtype=np.float32)
    headwind = np.empty(spans, dtype=np.float32)
    cross_squared = np.empty(spans, dtype=np.float32)
    span_drag = np.empty(spans, dtype=np.float32)
    for i in range(spans):
        row = span_row[i]
        powers[i] = _pushed_power(flat_power, per_force, max_ratio, static_extra[i] + air_extra_n[row])[1]
        headwind[i] = headwind_ms[row]
        cross_squared[i] = crosswind_ms[row] * crosswind_ms[row]
        span_drag[i] = drag[row]
    speeds = np.empty(spans, dtype=np.float32)
    for i in range(spans):
        low = lowest
        high = highest
        for _ in range(_SPEED_SOLVE_ITERATIONS):
            middle = (low + high) * half
            required = _resistance_n(middle, constant_force[i], headwind[i], cross_squared[i], span_drag[i]) * middle
            # 必要な出力が持っている出力を超えるなら、その速度は出せない（上限を下げる）。NaNは超えない側へ倒す。
            if required > powers[i]:
                high = middle
            else:
                low = middle
        speeds[i] = (low + high) * half
    return speeds, powers


#: 釣り合いの速さに着いたとみなす差（m/s）。速さが釣り合いの速さへ近づくのは漸近なので、この差まで近づいたら着いたとし、
#: 点の間の残りを釣り合いの速さで走る。二分法が詰める幅（約0.003m/s）より広くとり、着く手前で力の符号が変わらないようにする。
_CARRY_SETTLED_MS = 0.01
#: 力を運動エネルギーの1次式とみなして解く1つの刻みで、速さを変える幅の上限（m/s）。出力÷速さの項は速さの変わり方が大きいほど
#: 1次式から外れるので、速さの差が大きい所（急な下りから登りへ・押して歩く速さからの加速）はこの幅ずつに刻んで解く。
_CARRY_SPEED_STEP_MS = 1.0


@njit(cache=True, nogil=True)
def _net_force(speed: float, power: float, constant_force: float, headwind: float, cross_squared: float,
               drag: float) -> float:
    """速さ`speed`で出力`power`を出したときの、進む向きの正味の力（N）。正なら加速し、負なら減速する。"""
    return power / speed - _resistance_n(speed, constant_force, headwind, cross_squared, drag)


@njit(cache=True, nogil=True)
def _carry_piece(speed: float, target: float, length: float, power: float, constant_force: float, headwind: float,
                 cross_squared: float, drag: float, mass_kg: float) -> tuple[float, float, float]:
    """出力`power`で、速さ`speed`から`target`へ向かって最長`length`進む。`(進んだ道のり, かかった秒, 終わりの速さ)`。

    運動エネルギー e = ½v² の道のりあたりの変化 m·de/ds = 正味の力 を、2つの速さで力を e の1次式とみなして解く。1次式なら力は
    道のりに沿って指数で変わり（f(s) = f0·exp(k·s/m)）、`target`に着く道のりは対数で出る。秒は、始まり・中ほど・終わりの速さの
    逆数をシンプソンの式で積む（中ほどの指数は、終わりの指数の平方根）。ライブラリの数値積分（scipy の`solve_ivp`等）は JIT の
    ループの中で点の間ごとに呼べないので、閉じた形で解く。"""
    e0 = 0.5 * speed * speed
    et = 0.5 * target * target
    f0 = _net_force(speed, power, constant_force, headwind, cross_squared, drag)
    ft = _net_force(target, power, constant_force, headwind, cross_squared, drag)
    ratio = ft / f0
    slope = (ft - f0) / (et - e0)
    if 0.0 < ratio < 1.0:
        growth = np.exp(slope * length / mass_kg)
        if growth <= ratio:  # `length`の中で`target`に着く
            run = mass_kg / slope * np.log(ratio)
            growth = ratio
            end = target
        else:
            run = length
            end = np.sqrt(max(2.0 * (e0 + f0 * (growth - 1.0) / slope), 1e-6))
        middle = np.sqrt(max(2.0 * (e0 + f0 * (np.sqrt(growth) - 1.0) / slope), 1e-6))
    else:
        # 2つの速さで力の大きさが減らない（1次式の指数が減る向きにならない）ときは、始まりの力のまま等加速で進む。
        run = min(length, mass_kg * (et - e0) / f0)
        end = target if run < length else np.sqrt(max(2.0 * (e0 + f0 * run / mass_kg), 1e-6))
        middle = np.sqrt(max(2.0 * (e0 + f0 * 0.5 * run / mass_kg), 1e-6))
    return run, run / 6.0 * (1.0 / speed + 4.0 / middle + 1.0 / end), end


@njit(cache=True, nogil=True)
def _carried_spans(span_row: np.ndarray, span_length: np.ndarray, carries: np.ndarray, constant_force: np.ndarray,
                   speeds: np.ndarray, powers: np.ndarray, headwind_ms: np.ndarray, crosswind_ms: np.ndarray,
                   drag: np.ndarray, rider: np.ndarray, rows: int) -> tuple[np.ndarray, np.ndarray]:
    """`(区間の行ごとの走った秒, 点の間ごとの踏み増して走った秒)`（float64）。

    勢いを引き継がない点の間（`carries`が偽）は釣り合いの速さ`speeds`で走り、そこから先の勢いをその速さで始める。引き継ぐ点の間は、
    今の速さが釣り合いの速さより速ければ平地の出力で、遅ければその点の間の出力`powers`で、釣り合いの速さへ向かって速さの幅
    `_CARRY_SPEED_STEP_MS`ずつ進み（`_carry_piece`）、着いたら残りを釣り合いの速さで走る。踏み増して走った秒は、その点の間の出力で
    走った秒（平地の出力より踏むのは、出力が平地の出力を越える点の間だけ）。"""
    seconds = np.zeros(rows)
    pushed = np.empty(len(span_row))
    mass = np.float64(rider[_RIDER_WEIGHT]) / _GRAVITY_M_S2
    flat_power = np.float64(rider[_RIDER_FLAT_POWER])
    speed = 0.0
    for i in range(len(span_row)):
        row = span_row[i]
        length = np.float64(span_length[i])
        settled = np.float64(speeds[i])
        if not carries[i] or abs(speed - settled) <= _CARRY_SETTLED_MS:
            pushed[i] = length / settled
            seconds[row] += pushed[i]
            speed = settled
            continue
        headwind = np.float64(headwind_ms[row])
        cross_squared = np.float64(crosswind_ms[row]) ** 2
        row_drag = np.float64(drag[row])
        force = np.float64(constant_force[i])
        coasting = speed > settled
        power = flat_power if coasting else np.float64(powers[i])
        final = settled + _CARRY_SETTLED_MS if coasting else settled - _CARRY_SETTLED_MS
        left = length
        moving = 0.0
        while True:
            target = final if abs(speed - final) <= _CARRY_SPEED_STEP_MS else (
                speed - _CARRY_SPEED_STEP_MS if coasting else speed + _CARRY_SPEED_STEP_MS)
            run, spent, speed = _carry_piece(speed, target, left, power, force, headwind, cross_squared, row_drag, mass)
            moving += spent
            left -= run
            if left <= 0.0 or target == final and speed == final:
                break
        rest = 0.0
        if left > 0.0:  # 釣り合いの速さに着いた。残りを釣り合いの速さで走る
            speed = settled
            rest = left / settled
        seconds[row] += moving + rest
        pushed[i] = rest if coasting else moving + rest
    return seconds, pushed


@njit(cache=True, nogil=True)
def _span_work(span_row: np.ndarray, pushed_seconds: np.ndarray, span_grade: np.ndarray,
               powers: np.ndarray, static_extra: np.ndarray, crr: np.ndarray, air_extra_n: np.ndarray,
               rider: np.ndarray, rows: int, weight_exponent: float) -> np.ndarray:
    """平地の出力を越えて踏んだ体力（J）を、区間の行ごとに重力・空気・転がりの分へ足す（`(3, 行数)`、float64）。

    越えて踏んだ体力は、（その点の間の出力−平地の出力）× 踏み増して走った秒（`_carried_spans`）で、平地より増えた抵抗のうち
    正のものの比で配る——上限で頭打ちになったときも同じ比。点の間ごとに、上限で切る前の踏みたい出力と平地の出力の比の
    `weight_exponent`乗を重みとして掛ける（0なら重みを掛けない事実の量）——上限を越えて踏みたい坂ほど重い。"""
    work = np.zeros((3, rows))
    weight = np.float64(rider[_RIDER_WEIGHT])
    flat_power = np.float64(rider[_RIDER_FLAT_POWER])
    per_force = np.float64(rider[_RIDER_POWER_PER_FORCE])
    max_ratio = np.float64(rider[_RIDER_MAX_RATIO])
    inverse_flat = 1.0 / flat_power
    for i in range(len(span_row)):
        row = span_row[i]
        parts = (max(weight * span_grade[i], 0.0), max(np.float64(air_extra_n[row]), 0.0),
                 max((np.float64(crr[row]) - rider[_RIDER_BASE_CRR]) * weight, 0.0))
        total = parts[0] + parts[1] + parts[2]
        if total <= 0.0:
            continue
        excess_j = (np.float64(powers[i]) - flat_power) * pushed_seconds[i]
        if weight_exponent != 0.0:
            desired = _pushed_power(flat_power, per_force, max_ratio,
                                    np.float64(static_extra[i]) + np.float64(air_extra_n[row]))[0]
            ratio = desired * inverse_flat
            # 既定の1乗は累乗を呼ばない（点の間ごとに呼ぶので、累乗の分だけ遅い）。
            excess_j *= ratio if weight_exponent == 1.0 else ratio ** weight_exponent
        for k in range(3):
            work[k, row] += excess_j * parts[k] / total
    return work


@dataclass(frozen=True)
class SegmentRide:
    """区間ごとの走行時間（秒）と、平地の出力を越えて踏んだ体力（J）の費目ごとの内訳（重力・空気・転がりと、止まる出来事の
    漕ぎ出しの慣性。4つの和が越えて踏んだ体力の全部）。"""

    seconds: np.ndarray  # float64
    gravity_extra_j: np.ndarray
    air_extra_j: np.ndarray
    rolling_extra_j: np.ndarray
    inertia_extra_j: np.ndarray


class SegmentSpeedModel:
    """区間ごとの走行モデルのうち、天気に依らない部分（断面の点の間・区間の標高の気圧・路面・乗り手と較正値）を先に1回だけ
    揃えたもの。風の成分と気温を渡すたびに、点の間ごとに速さを解いて区間の秒へ足す。

    時刻ビンごとに変わるのは風と気温だけなので、ルート生成は探索範囲に1回作ってビンの数だけ解く。
    較正値は作るときに渡す。**配列はすべて区間の行の数で渡す**——長さの違う配列を区間の番号で
    読み違えないよう、揃っていることをここで確かめる。
    """

    def __init__(self, profile: RiderProfile, spans: ProfileSpans, distance_m: np.ndarray,
                 crr: np.ndarray, kickoffs: np.ndarray, tuning: Tuning) -> None:
        """`spans`は区間の行ごとの点の間（`domain/elevation_profile.py: profile_spans`）、`distance_m`は区間の長さ、`crr`は
        区間ごとの転がり抵抗（`crr_for_surface`）、`kickoffs`は区間の止まる出来事の漕ぎ出しの回数（`domain/traffic.py: StopEvent.kickoffs`の和）。"""
        shape = np.shape(distance_m)
        mismatched = {name: np.shape(array) for name, array in (
            ("crr", crr), ("kickoffs", kickoffs), ("spans.start", spans.start), ("spans.count", spans.count),
            ("spans.unknown_m", spans.unknown_m)) if np.shape(array) != shape}
        if mismatched:
            raise ValueError(f"区間の配列の長さが揃っていません distance_m={shape} {mismatched}")
        distance = kernel_array(distance_m, np.float64)
        #: 区間の行ごとの長さ（m、float64）。
        self.distance_m = distance
        #: 区間の行ごとの標高の無い長さ（m）。全体の分布で埋めて走る（所要時間の欠けの割合が読む）。
        self.unknown_m = np.asarray(spans.unknown_m, dtype=np.float64)
        span_row, span_length, span_grade, carries = spans.flat()
        crr = kernel_array(crr, np.float32)
        # 区間の行の気圧は、断面の値のある点の標高の平均から出す。値のある点が無い行は海面（0m）とする。
        row_elevation = np.asarray(spans.mean_elevation_m, dtype=np.float64)
        pressure_kpa = _air_pressure_kpa(np.where(np.isnan(row_elevation), 0.0, row_elevation))
        # 体力と漕ぎ出しが負・無限大にならない値だけで解く（上限倍率が1未満だと平地の出力を越えた分が負になる）。
        require_tuning({"speed.mass_kg": profile.mass_kg}, profile.mass_kg > 0, "0より大きい")
        power_per_force = tuning.checked("speed.extra_power_per_force", lambda v: v >= 0, "0以上")
        max_ratio = tuning.checked("speed.max_climb_power_ratio", lambda v: v >= 1, "1以上")
        walking_kmh = tuning.checked("speed.walking_kmh", lambda v: v > 0, "0より大きい")
        self._kickoff_extra_j = kickoff_extra_j(profile, tuning)
        #: 平地・無風の巡航速度のホイール出力（W）。体力を秒へ換算する基準（`domain/ledger_costs.py`）。
        self.flat_power_w = wheel_power_w(profile)
        require_tuning({"speed.cda_m2": profile.cda_m2, BASE_CRR_ID: profile.crr, "speed.mass_kg": profile.mass_kg},
                       self.flat_power_w > 0, "巡航速度で平地の出力が0より大きくなる組")
        rider = np.empty(9, dtype=np.float32)
        rider[_RIDER_WEIGHT] = profile.mass_kg * _GRAVITY_M_S2
        rider[_RIDER_FLAT_POWER] = self.flat_power_w
        rider[_RIDER_BASE_CRR] = profile.crr
        # 1Nあたりの踏み増しを巡航速度（m/s）で止める。踏みたい出力が、その条件で巡航速度を保つ出力（平地の出力＋巡航速度×
        # 増えた抵抗）を越えない——越えると、巡航の遅い人が登りや向かい風で巡航より速く走る。
        rider[_RIDER_POWER_PER_FORCE] = min(power_per_force, profile.cruise_speed_ms)
        rider[_RIDER_MAX_RATIO] = max_ratio
        rider[_RIDER_HALF_CDA] = 0.5 * profile.cda_m2
        rider[_RIDER_LOWEST] = kmh_to_ms(walking_kmh)
        rider[_RIDER_HIGHEST] = kmh_to_ms(top_speed_kmh(profile.cruise_speed_kmh, tuning))
        rider[_RIDER_CRUISE] = profile.cruise_speed_ms
        self._rider = rider
        constant_force, static_extra = _span_static(span_row, span_grade, crr, rider)
        self._spans = _Spans(span_row, span_length, span_grade, carries, constant_force, static_extra, crr,
                             np.asarray(kickoffs, dtype=np.float64), pressure_kpa, len(distance_m))

    def travel_seconds(self, headwind_ms: np.ndarray, crosswind_ms: np.ndarray, temperature_c: np.ndarray) -> np.ndarray:
        """区間ごとの走行時間（秒、float64）。`headwind_ms`は進行方向への向かい風成分（正が向かい風）、`crosswind_ms`は横成分、
        `temperature_c`は気温（℃。予報を使わない計算は`STANDARD_TEMPERATURE_C`）。"""
        spans = self._spans
        seconds, _pushed, _powers, _air = self._solve(spans, headwind_ms, crosswind_ms, temperature_c)
        return seconds

    def ride(self, headwind_ms: np.ndarray, crosswind_ms: np.ndarray, temperature_c: np.ndarray, weight_exponent: float,
             rows: np.ndarray | None = None) -> SegmentRide:
        """区間ごとの走行時間と、平地の出力を越えて踏んだ体力の費目ごとの内訳。体力には、点の間ごとに踏みたい出力（上限で切る前）
        と平地の出力の比の`weight_exponent`乗の重みを掛ける（0なら事実の量そのもの。重みを掛けると内訳はJではなく重みを掛けた
        量）。漕ぎ出しは上限の出力で踏むので、重みは上限の比の`weight_exponent`乗（`kickoff_effort_j`）。

        `rows`（区間の行。重なってよい）を渡すとその行の点の間だけを解き、風の成分と気温も返す配列も`rows`の並びになる——経路の
        数百行を読むのに道路網の全部を解かない。行ごとの計算は互いに依らない（勢いは行の中でだけ持ち越す）ので、全部を解いたときの
        その行と同じ値になる。"""
        spans = self._spans if rows is None else self._spans_of(np.asarray(rows, dtype=np.int64))
        seconds, pushed, powers, air_extra_n = self._solve(spans, headwind_ms, crosswind_ms, temperature_c)
        work = _span_work(spans.row, pushed, spans.grade, powers, spans.static_extra,
                          spans.crr, air_extra_n, self._rider, spans.rows, float(weight_exponent))
        return SegmentRide(seconds=seconds,
                           gravity_extra_j=work[0], air_extra_j=work[1], rolling_extra_j=work[2],
                           inertia_extra_j=spans.kickoffs * self.kickoff_effort_j(weight_exponent))

    def _spans_of(self, rows: np.ndarray) -> "_Spans":
        """行`rows`の点の間だけを抜き出し、点の間の行を`rows`の中の位置へ付け替えたもの（点の間は行の昇順に並んでいる）。"""
        spans = self._spans
        first = np.searchsorted(spans.row, rows, side="left")
        counts = np.searchsorted(spans.row, rows, side="right") - first
        position = np.repeat(np.arange(len(rows), dtype=np.int32), counts)
        taken = range_positions(first, counts)
        return _Spans(position, spans.length[taken], spans.grade[taken], spans.carries[taken], spans.constant_force[taken],
                      spans.static_extra[taken], spans.crr[rows], spans.kickoffs[rows], spans.pressure_kpa[rows], len(rows))

    def kickoff_effort_j(self, weight_exponent: float) -> float:
        """止まる出来事1回の漕ぎ出しの体力（J）に、上限の出力と平地の出力の比の`weight_exponent`乗の重みを掛けたもの（曲がる所の
        漕ぎ出しも同じ換算）。"""
        return self._kickoff_extra_j * float(self._rider[_RIDER_MAX_RATIO]) ** weight_exponent

    def _solve(self, spans: "_Spans", headwind_ms: np.ndarray, crosswind_ms: np.ndarray,
               temperature_c: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """`spans`の区間の行ごとの走った秒、点の間ごとの踏み増して走った秒と踏む出力、区間ごとの向かい風で増えた空気抵抗（N）。"""
        headwind = kernel_array(headwind_ms, np.float32)
        cross = kernel_array(crosswind_ms, np.float32)
        temperature = np.asarray(temperature_c, dtype=np.float64)
        mismatched = {name: array.shape for name, array in (
            ("headwind_ms", headwind), ("crosswind_ms", cross), ("temperature_c", temperature)) if array.shape != (spans.rows,)}
        if mismatched:
            raise ValueError(f"区間の配列の長さが揃っていません 区間={spans.rows} {mismatched}")
        drag = kernel_array(self._rider[_RIDER_HALF_CDA] * _air_density_kg_m3(spans.pressure_kpa, temperature), np.float32)
        # 向かい風で増えた空気抵抗（N）は、風の材料と同じ式を巡航速度で測る——速さに依らない基準で測り、踏む出力が解く
        # 速さに依らないようにする。
        air_extra_n = kernel_array(drag * drag_increases_m2_s2(headwind, cross, self._rider[_RIDER_CRUISE]), np.float32)
        speeds, powers = _span_speeds(spans.row, spans.constant_force, spans.static_extra, air_extra_n, headwind, cross,
                                      drag, self._rider)
        seconds, pushed = _carried_spans(spans.row, spans.length, spans.carries, spans.constant_force, speeds, powers,
                                         headwind, cross, drag, self._rider, spans.rows)
        return seconds, pushed, powers, air_extra_n


@dataclass(frozen=True)
class _Spans:
    """解く点の間の並び（`row`は点の間ごとの、結果の配列の位置。昇順）と、結果の配列の位置ごとの路面・漕ぎ出しの回数・気圧（kPa）。"""

    row: np.ndarray
    length: np.ndarray
    grade: np.ndarray
    carries: np.ndarray  # bool、前の点の間から勢いを引き継ぐか（`ProfileSpans.carries`）
    constant_force: np.ndarray
    static_extra: np.ndarray
    crr: np.ndarray
    kickoffs: np.ndarray
    pressure_kpa: np.ndarray
    rows: int
