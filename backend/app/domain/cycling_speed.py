"""自転車の走行モデル（所要時間の物理）。

区間ごとの速度は走行方程式で決まる:

    ホイール出力 P = ( 空気抵抗 + 転がり抵抗 + 重力 ) × 速度
    空気抵抗 = ½ × ρ × CdA × (速度 + 向かい風)²
    転がり抵抗 = Crr × 質量 × g
    重力     = 質量 × g × 勾配

利用者から取る入力は**平地・無風の巡航速度**だけで、そこからホイール出力を逆算する
（`wheel_power_w`）。体重・出力・ケイデンスは一般の利用者が答えられないため、CdA・Crr・質量は
標準値を使う。坂・向かい風・路面で抵抗が増えると、同じ決まりで踏み増す（`pushed_power_w`）。「向かい風に強い／弱い」の差の
多くは巡航速度の違いとして式から出る。

**駆動系の伝達効率は掛けない**。巡航速度から逆算するのはホイールでの出力で、他の条件でも
同じ量を使うため相殺される。

速度の逆算は`v`の3次方程式になるため二分法で解く（`SegmentSpeedModel`、区間の断面の点の間ごとのループをnumbaでJITする）。
探索中には呼ばず、コスト配列を合成するときに区間ごと（風は時刻ビンごと）へ事前計算する。
"""

from dataclasses import dataclass, field

import numpy as np
from numba import njit

from app.domain.attributes import CategoricalColumn
from app.domain.elevation_profile import ElevationProfiles, flatten_spans, unknown_lengths_m
from app.domain.road_classes import class_material_id, current_road_classes
from app.domain.search_graph import kernel_array
from app.domain.traffic import stop_count_material_ids
from app.domain.tuning import TUNING_PARAMETERS_BY_ID, tuning_value
from app.domain.wind import drag_increases_m2_s2, kmh_to_ms

_AIR_DENSITY_KG_M3 = 1.225
_GRAVITY_M_S2 = 9.80665

# 走ってみて決める値（CdA・Crr・質量・速度の上下限・登りの出力の増え方等）は
# `domain/tuning.py`が宣言し、ここでは読むだけにする。定数として持つと、宣言と二重に
# なったうえ管理画面からの変更が効かない。

# 速度を挟み込む二分法の反復回数。初期区間は押して歩く速度〜速度の上限（`top_speed_kmh`。巡航速度の上限は
# `domain/route_request.py: MAX_ASSUMED_SPEED_KMH`）で、12回で幅は初期区間の4096分の1（巡航速度が上限でも0.01km/h程度）まで縮む。粗くすると平地・無風で巡航速度に一致しなくなる。
_SPEED_SOLVE_ITERATIONS = 12

#: 区間ごとに速度を変える道と天気の条件の、画面で呼ぶ名前（走行方程式の重力・空気抵抗・転がり抵抗の順）。
#: 画面の所要時間の説明はこの並びを差し込む。方程式に条件を足したら、ここにも足す。
SEGMENT_SPEED_CONDITIONS: tuple[str, ...] = ("坂", "風", "路面")

#: 基準の転がり抵抗の較正値のid。
BASE_CRR_ID = "speed.crr"


def rolling_resistance_material_id() -> str | None:
    """走行モデルが転がり抵抗に読む区分の列の材料id（転がり抵抗の表が指す分け方。指していなければNone）。"""
    key = current_road_classes().rolling_resistance_classification
    return class_material_id(key) if key is not None else None


def travel_model_material_ids() -> tuple[str, ...]:
    """所要時間（走行方程式の路面と、停止の待ち）が区間ごとに読む材料id。勾配は材料ではなく区間の断面の点から読む
    （`domain/elevation_profile.py`）。

    静的スコア行列はこれらを**軸の構成と無関係に**列として運び、欠けた行列は組み立てで断る
    （`evaluation.py: StaticEdgeScoreMatrix`）。軸が分解した材料だけを運ぶ既定に任せると、その軸を
    非公開にした瞬間に所要時間から路面・停止の待ちが静かに消える。
    """
    rolling = rolling_resistance_material_id()
    return (*((rolling,) if rolling is not None else ()), *stop_count_material_ids())


def crr_for_surface(rolling_classes: CategoricalColumn) -> np.ndarray:
    """路面の見込み（転がり抵抗の表が指す分け方の区分）から、区間ごとの転がり抵抗を返す。

    区分の外の道・表に無い区分・宣言に無い較正値のidは、基準の転がり抵抗（`RiderProfile.crr`）にする。
    """
    definitions = current_road_classes()
    ids = definitions.rolling_resistance_classes.get(definitions.rolling_resistance_classification or "", {})
    table = {key: tuning_value(tuning_id) for key, tuning_id in ids.items() if tuning_id in TUNING_PARAMETERS_BY_ID}
    crr = rolling_classes.lookup(table)
    return np.where(np.isnan(crr), tuning_value(BASE_CRR_ID), crr)


@dataclass(frozen=True)
class RiderProfile:
    """走行モデルの個人パラメータ。利用者が入力するのは巡航速度だけで、残りは標準値。"""

    cruise_speed_kmh: float
    # 標準値は宣言（`domain/tuning.py`）が持ち、作り手は渡さない。読むのは**生成のたび**で、
    # import時ではない——import時に束ねると、管理画面から変えた値が効かない。
    cda_m2: float = field(init=False, default_factory=lambda: tuning_value("speed.cda_m2"))
    crr: float = field(init=False, default_factory=lambda: tuning_value(BASE_CRR_ID))
    mass_kg: float = field(init=False, default_factory=lambda: tuning_value("speed.mass_kg"))

    @property
    def cruise_speed_ms(self) -> float:
        return kmh_to_ms(self.cruise_speed_kmh)


def wheel_power_w(profile: RiderProfile) -> float:
    """平地・無風の巡航速度からホイール出力（W）を逆算する。"""
    speed = profile.cruise_speed_ms
    drag = 0.5 * _AIR_DENSITY_KG_M3 * profile.cda_m2 * speed * speed
    rolling = profile.crr * profile.mass_kg * _GRAVITY_M_S2
    return (drag + rolling) * speed


@njit(cache=True, nogil=True)
def _pushed_power(flat_power_w: float, power_per_force: float, max_ratio: float,
                  extra_force_n: float) -> tuple[float, float]:
    """`pushed_power_w`の計算（JITのループから呼ぶ。較正値は呼び手が読んで渡す）。"""
    desired = flat_power_w + power_per_force * max(extra_force_n, 0.0)
    return desired, min(desired, flat_power_w * max_ratio)


def pushed_power_w(flat_power_w: float, extra_force_n: float) -> tuple[float, float]:
    """抵抗が平地より`extra_force_n`（N。負なら平地より楽）増えたときに、踏みたい出力と実際に踏む出力（W）。

    踏みたい出力は、増えた抵抗1Nごとに決まったW（較正値`speed.extra_power_per_force`）を平地の出力へ足したもの。坂の重力も
    向かい風の空気抵抗も路面の転がり抵抗も、同じ決まりで踏み増す。抵抗が平地より減る区間（下り・追い風）は平地の出力のまま
    （減らさない）。実際に踏む出力は、踏みたい出力を平地の出力の上限倍率で止めたもの。

    一定出力で計算すると平地20km/hの人が勾配5%で時速4.6km＝押して歩く速度になり現実と合わないため、抵抗に比例して
    踏む量を増やす。足す量を平地の出力に比例させない——比例させると巡航が速い人ほど登りで踏み増し、坂でも平地並みの
    速度を保って所要時間が短く出る。
    """
    return _pushed_power(float(flat_power_w), tuning_value("speed.extra_power_per_force"),
                         tuning_value("speed.max_climb_power_ratio"), float(extra_force_n))


def kickoff_extra_j(profile: RiderProfile) -> float:
    """止まる出来事1回の漕ぎ出しで、平地の出力を越えて踏む体力（J）。止まった所から巡航速度まで、平地の出力の上限倍率
    （`speed.max_climb_power_ratio`）で踏んで加速する前提で、要る運動エネルギー½mv²のうち平地の出力を越えた分
    （1 − 1/上限倍率）。"""
    speed = profile.cruise_speed_ms
    return 0.5 * profile.mass_kg * speed * speed * (1.0 - 1.0 / tuning_value("speed.max_climb_power_ratio"))


def top_speed_kmh(cruise_speed_kmh: float) -> float:
    """区間の速度の上限。下りの上限か、それより速ければ巡航速度。

    下りの上限だけで止めると、それより速い巡航速度を入れた人が平地・無風でも上限で頭打ちになり、
    入れた速度が所要時間に効かない。
    """
    return max(tuning_value("speed.max_descent_kmh"), cruise_speed_kmh)


#: `SegmentSpeedModel`がJITへ渡す、乗り手と較正値の数の並び（1本のfloat32の配列で渡す）。
_RIDER_WEIGHT, _RIDER_FLAT_POWER, _RIDER_BASE_CRR, _RIDER_POWER_PER_FORCE, _RIDER_MAX_RATIO, _RIDER_DRAG, _RIDER_LOWEST, \
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
def _span_speeds(span_row: np.ndarray, constant_force: np.ndarray, static_extra: np.ndarray, air_extra_n: np.ndarray,
                 headwind_ms: np.ndarray, crosswind_ms: np.ndarray, rider: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """点の間ごとの`(速度（m/s）, 実際に踏む出力（W）)`。踏む出力は`pushed_power_w`の決まり、速度は走行方程式
    `P = 抵抗力(v) × v`を二分法で解いたもの（3次方程式。ニュートン法は抵抗力が0を跨ぐ下り坂で発散しうるため、区間を
    確実に狭める方を採る）。

    **演算はすべてfloat32で、1つずつ丸める**（numbaは`fastmath`を立てなければ演算をまとめない）。float32の有効桁は
    7桁で、二分法が詰める幅（0.003m/s）より4桁細かい。"""
    flat_power = rider[_RIDER_FLAT_POWER]
    per_force = rider[_RIDER_POWER_PER_FORCE]
    ceiling = flat_power * rider[_RIDER_MAX_RATIO]
    drag = rider[_RIDER_DRAG]
    lowest = rider[_RIDER_LOWEST]
    highest = rider[_RIDER_HIGHEST]
    zero = np.float32(0.0)
    half = np.float32(0.5)
    spans = len(span_row)
    # 区間の行の風を点の間へ配るループと、解くループを分ける——解くループが並びを順に読むだけになり、CPUが複数の点の間を
    # まとめて計算できる（行を引いて読むと、まとめられず数倍遅い）。
    powers = np.empty(spans, dtype=np.float32)
    headwind = np.empty(spans, dtype=np.float32)
    cross_squared = np.empty(spans, dtype=np.float32)
    for i in range(spans):
        row = span_row[i]
        powers[i] = min(flat_power + per_force * max(static_extra[i] + air_extra_n[row], zero), ceiling)
        headwind[i] = headwind_ms[row]
        cross_squared[i] = crosswind_ms[row] * crosswind_ms[row]
    speeds = np.empty(spans, dtype=np.float32)
    for i in range(spans):
        low = lowest
        high = highest
        for _ in range(_SPEED_SOLVE_ITERATIONS):
            middle = (low + high) * half
            along = middle + headwind[i]
            required = (np.sqrt(along * along + cross_squared[i]) * along * drag + constant_force[i]) * middle
            # 必要な出力が持っている出力を超えるなら、その速度は出せない（上限を下げる）。NaNは超えない側へ倒す。
            if required > powers[i]:
                high = middle
            else:
                low = middle
        speeds[i] = (low + high) * half
    return speeds, powers


@njit(cache=True, nogil=True)
def _span_seconds(span_row: np.ndarray, span_length: np.ndarray, speeds: np.ndarray, rows: int) -> np.ndarray:
    """点の間を走った秒を、区間の行ごとに足す（float64）。"""
    seconds = np.zeros(rows)
    for i in range(len(span_row)):
        seconds[span_row[i]] += np.float64(span_length[i]) / np.float64(speeds[i])
    return seconds


@njit(cache=True, nogil=True)
def _span_work(span_row: np.ndarray, span_length: np.ndarray, span_grade: np.ndarray, speeds: np.ndarray,
               powers: np.ndarray, static_extra: np.ndarray, crr: np.ndarray, air_extra_n: np.ndarray, rider: np.ndarray,
               rows: int, weight_exponent: float) -> np.ndarray:
    """平地の出力を越えて踏んだ体力（J）を、区間の行ごとに重力・空気・転がりの分へ足す（`(3, 行数)`、float64）。

    越えて踏んだ出力（実際に踏む出力−平地の出力）は、平地より増えた抵抗のうち正のものの比で配る——上限で頭打ちになった
    ときも同じ比。点の間ごとに、上限で切る前の踏みたい出力と平地の出力の比の`weight_exponent`乗を重みとして掛ける
    （0なら重みを掛けない事実の量）——上限を越えて踏みたい坂ほど重い。"""
    work = np.zeros((3, rows))
    weight = np.float64(rider[_RIDER_WEIGHT])
    flat_power = np.float64(rider[_RIDER_FLAT_POWER])
    per_force = np.float64(rider[_RIDER_POWER_PER_FORCE])
    for i in range(len(span_row)):
        row = span_row[i]
        parts = (max(weight * span_grade[i], 0.0), max(np.float64(air_extra_n[row]), 0.0),
                 max((np.float64(crr[row]) - rider[_RIDER_BASE_CRR]) * weight, 0.0))
        total = parts[0] + parts[1] + parts[2]
        if total <= 0.0:
            continue
        excess_j = (np.float64(powers[i]) - flat_power) * np.float64(span_length[i]) / np.float64(speeds[i])
        if weight_exponent != 0.0:
            desired = flat_power + per_force * max(np.float64(static_extra[i]) + np.float64(air_extra_n[row]), 0.0)
            excess_j *= (desired / flat_power) ** weight_exponent
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
    """区間ごとの走行モデルのうち、風に依らない部分（断面の点の間・路面・乗り手と較正値）を先に1回だけ揃えたもの。風の
    成分を渡すたびに、点の間ごとに速さを解いて区間の秒へ足す。

    時刻ビンごとに変わるのは風だけなので、ルート生成は探索範囲に1回作ってビンの数だけ解く。
    較正値は作った時点で読む。**配列はすべて区間の行の数で渡す**——長さの違う配列を区間の番号で
    読み違えないよう、揃っていることをここで確かめる。
    """

    def __init__(self, profile: RiderProfile, profiles: ElevationProfiles, distance_m: np.ndarray,
                 crr: np.ndarray, kickoffs: np.ndarray) -> None:
        """`profiles`は区間の行ごとの断面、`distance_m`は区間の長さ、`crr`は区間ごとの転がり抵抗（`crr_for_surface`）、
        `kickoffs`は区間の止まる出来事の漕ぎ出しの回数（`domain/traffic.py: StopEvent.kickoffs`の和）。"""
        self._rows = len(distance_m)
        self._shape = np.shape(distance_m)
        mismatched = {name: np.shape(array) for name, array in (
            ("crr", crr), ("kickoffs", kickoffs), ("profiles.start", profiles.start),
            ("profiles.points", profiles.points), ("profiles.forward", profiles.forward)) if np.shape(array) != self._shape}
        if mismatched:
            raise ValueError(f"区間の配列の長さが揃っていません distance_m={self._shape} {mismatched}")
        start = kernel_array(profiles.start, np.int64)
        points = kernel_array(profiles.points, np.int64)
        elevation = kernel_array(profiles.elevation_m, np.float32)
        distance = kernel_array(distance_m, np.float64)
        #: 区間の行ごとの標高の無い長さ（m）。全体の分布で埋めて走る（所要時間の欠けの割合が読む）。
        self.unknown_m = unknown_lengths_m(start, points, elevation, distance)
        self._span_row, self._span_length, self._span_grade = flatten_spans(
            start, points, kernel_array(profiles.forward, np.bool_), elevation, distance, self.unknown_m,
            kernel_array(profiles.distribution.grade, np.float64), kernel_array(profiles.distribution.share, np.float64))
        self._crr = kernel_array(crr, np.float32)
        self._kickoffs = kickoffs
        self._kickoff_extra_j = kickoff_extra_j(profile)
        rider = np.empty(9, dtype=np.float32)
        rider[_RIDER_WEIGHT] = profile.mass_kg * _GRAVITY_M_S2
        rider[_RIDER_FLAT_POWER] = wheel_power_w(profile)
        rider[_RIDER_BASE_CRR] = profile.crr
        rider[_RIDER_POWER_PER_FORCE] = tuning_value("speed.extra_power_per_force")
        rider[_RIDER_MAX_RATIO] = tuning_value("speed.max_climb_power_ratio")
        rider[_RIDER_DRAG] = 0.5 * _AIR_DENSITY_KG_M3 * profile.cda_m2
        rider[_RIDER_LOWEST] = kmh_to_ms(tuning_value("speed.walking_kmh"))
        rider[_RIDER_HIGHEST] = kmh_to_ms(top_speed_kmh(profile.cruise_speed_kmh))
        rider[_RIDER_CRUISE] = profile.cruise_speed_ms
        self._rider = rider
        self._constant_force, self._static_extra = _span_static(self._span_row, self._span_grade, self._crr, rider)

    def travel_seconds(self, headwind_ms: np.ndarray, crosswind_ms: np.ndarray) -> np.ndarray:
        """区間ごとの走行時間（秒、float64）。`headwind_ms`は進行方向への向かい風成分（正が向かい風）、`crosswind_ms`は横成分。"""
        speeds, _powers, _air = self._solve(headwind_ms, crosswind_ms)
        return _span_seconds(self._span_row, self._span_length, speeds, self._rows)

    def ride(self, headwind_ms: np.ndarray, crosswind_ms: np.ndarray, weight_exponent: float) -> SegmentRide:
        """区間ごとの走行時間と、平地の出力を越えて踏んだ体力の費目ごとの内訳。体力には、点の間ごとに踏みたい出力（上限で切る前）
        と平地の出力の比の`weight_exponent`乗の重みを掛ける（0なら事実の量そのもの。慣性の漕ぎ出しは重みを掛けない——上限で
        踏む前提の量なので、重みは費用の式が掛ける）。"""
        speeds, powers, air_extra_n = self._solve(headwind_ms, crosswind_ms)
        work = _span_work(self._span_row, self._span_length, self._span_grade, speeds, powers, self._static_extra,
                          self._crr, air_extra_n, self._rider, self._rows, float(weight_exponent))
        return SegmentRide(seconds=_span_seconds(self._span_row, self._span_length, speeds, self._rows),
                           gravity_extra_j=work[0], air_extra_j=work[1], rolling_extra_j=work[2],
                           inertia_extra_j=np.asarray(self._kickoffs, dtype=np.float64) * self._kickoff_extra_j)

    def _solve(self, headwind_ms: np.ndarray, crosswind_ms: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """点の間ごとの速度と踏む出力、区間ごとの向かい風で増えた空気抵抗（N）。"""
        headwind = kernel_array(headwind_ms, np.float32)
        cross = kernel_array(crosswind_ms, np.float32)
        mismatched = {name: array.shape for name, array in (("headwind_ms", headwind), ("crosswind_ms", cross))
                      if array.shape != self._shape}
        if mismatched:
            raise ValueError(f"区間の配列の長さが揃っていません distance_m={self._shape} {mismatched}")
        # 向かい風で増えた空気抵抗（N）は、風の材料と同じ式を巡航速度で測る——速さに依らない基準で測り、踏む出力が解く
        # 速さに依らないようにする。
        air_extra_n = kernel_array(self._rider[_RIDER_DRAG] * drag_increases_m2_s2(
            headwind, cross, self._rider[_RIDER_CRUISE]), np.float32)
        speeds, powers = _span_speeds(self._span_row, self._constant_force, self._static_extra, air_extra_n, headwind, cross,
                                      self._rider)
        return speeds, powers, air_extra_n
