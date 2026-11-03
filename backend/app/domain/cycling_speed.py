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

速度の逆算は`v`の3次方程式になるため二分法で解く（`SegmentSpeedModel.speed_ms`、区間ごとのループをnumbaでJITする）。
探索中には呼ばず、コスト配列を合成するときに区間ごと（風は時刻ビンごと）へ事前計算する。
"""

from dataclasses import dataclass, field

import numpy as np
from numba import njit

from app.domain.attributes import CategoricalColumn
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.road_classes import class_material_id, current_road_classes
from app.domain.search_graph import kernel_array
from app.domain.traffic import stop_count_material_ids
from app.domain.tuning import TUNING_PARAMETERS_BY_ID, tuning_value
from app.domain.wind import kmh_to_ms

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
    """所要時間（走行方程式の勾配・路面と、停止の待ち）が区間ごとに読む材料id。

    静的スコア行列はこれらを**軸の構成と無関係に**列として運び、欠けた行列は組み立てで断る
    （`evaluation.py: StaticEdgeScoreMatrix`）。軸が分解した材料だけを運ぶ既定に任せると、その軸を
    非公開にした瞬間に所要時間から坂・路面・停止の待ちが静かに消える。
    """
    rolling = rolling_resistance_material_id()
    return (GRADIENT_PERCENT, *((rolling,) if rolling is not None else ()), *stop_count_material_ids())


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


def pushed_power_w(flat_power_w: float, extra_force_n: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """抵抗が平地より`extra_force_n`（N、区間ごとの和。負なら平地より楽）増えたときに、踏みたい出力と実際に踏む出力（W）。

    踏みたい出力は、増えた抵抗1Nごとに決まったW（較正値`speed.extra_power_per_force`）を平地の出力へ足したもの。坂の重力も
    向かい風の空気抵抗も路面の転がり抵抗も、同じ決まりで踏み増す。抵抗が平地より減る区間（下り・追い風）は平地の出力のまま
    （減らさない）。実際に踏む出力は、踏みたい出力を平地の出力の上限倍率で止めたもの。

    一定出力で計算すると平地20km/hの人が勾配5%で時速4.6km＝押して歩く速度になり現実と合わないため、抵抗に比例して
    踏む量を増やす。足す量を平地の出力に比例させない——比例させると巡航が速い人ほど登りで踏み増し、坂でも平地並みの
    速度を保って所要時間が短く出る。
    """
    desired = flat_power_w + tuning_value("speed.extra_power_per_force") * np.maximum(extra_force_n, 0.0)
    return desired, np.minimum(desired, flat_power_w * tuning_value("speed.max_climb_power_ratio"))


def top_speed_kmh(cruise_speed_kmh: float) -> float:
    """区間の速度の上限。下りの上限か、それより速ければ巡航速度。

    下りの上限だけで止めると、それより速い巡航速度を入れた人が平地・無風でも上限で頭打ちになり、
    入れた速度が所要時間に効かない。
    """
    return max(tuning_value("speed.max_descent_kmh"), cruise_speed_kmh)


@njit(cache=True, nogil=True)
def _segment_speeds(
    power: np.ndarray,
    constant_force: np.ndarray,
    drag_coefficient: np.float32,
    lowest_ms: np.float32,
    highest_ms: np.float32,
    headwind_ms: np.ndarray,
    crosswind_ms: np.ndarray,
) -> np.ndarray:
    """区間ごとに走行方程式を二分法で解いた速度（m/s、float32）。

    **演算はすべてfloat32で、1つずつ丸める**（numbaは`fastmath`を立てなければ演算をまとめない）。float32の有効桁は
    7桁で、二分法が詰める幅（0.003m/s）より4桁細かい。
    """
    speeds = np.empty(len(power), dtype=np.float32)
    half = np.float32(0.5)
    for i in range(len(power)):
        low = lowest_ms
        high = highest_ms
        headwind = headwind_ms[i]
        cross_squared = crosswind_ms[i] * crosswind_ms[i]
        for _ in range(_SPEED_SOLVE_ITERATIONS):
            middle = (low + high) * half
            along = middle + headwind
            required = (np.sqrt(along * along + cross_squared) * along * drag_coefficient + constant_force[i]) * middle
            # 必要な出力が持っている出力を超えるなら、その速度は出せない（上限を下げる）。NaNは超えない側へ倒す。
            if required > power[i]:
                high = middle
            else:
                low = middle
        speeds[i] = (low + high) * half
    return speeds


@dataclass(frozen=True)
class SegmentRide:
    """区間ごとに、走行方程式を解いた速度と、平地の出力を越えて踏んだ出力の抵抗ごとの内訳。

    越えて踏んだ出力（W）は、平地より増えた抵抗のうち正のもの（重力・空気・転がり）の比で配る——上限で頭打ちになった
    ときも同じ比。3つの和が、実際に踏んだ出力と平地の出力の差になる。`desired_ratio`は上限で止める前の踏みたい出力と
    平地の出力の比（体力の重みが読む）。
    """

    speed_ms: np.ndarray  # float32
    gravity_extra_w: np.ndarray  # float64
    air_extra_w: np.ndarray
    rolling_extra_w: np.ndarray
    desired_ratio: np.ndarray


class SegmentSpeedModel:
    """区間ごとの走行モデルのうち、風に依らない部分（重力と転がりの増えた抵抗・速度に依らない抵抗・挟み込みの初期区間）を
    先に1回だけ求めたもの。風の成分を渡すたびに踏む出力と速度を解く。

    時刻ビンごとに変わるのは風だけなので、ルート生成は探索範囲に1回作ってビンの数だけ解く。
    較正値は作った時点で読む。**配列はすべて`grade`と同じ長さで渡す**——長さの違う配列を区間の番号で
    読み違えないよう、揃っていることをここで確かめる。
    """

    def __init__(self, profile: RiderProfile, grade: np.ndarray, crr: np.ndarray) -> None:
        """`grade`は勾配（0.05なら5%）、`crr`は区間ごとの転がり抵抗（`crr_for_surface`）。"""
        grade = np.asarray(grade, dtype=np.float64)
        rolling_crr = np.asarray(crr, dtype=np.float64)
        if rolling_crr.shape != grade.shape:
            raise ValueError(f"区間の配列の長さが揃っていません grade={grade.shape} crr={rolling_crr.shape}")
        self._shape = grade.shape
        weight_n = profile.mass_kg * _GRAVITY_M_S2
        self._flat_power_w = wheel_power_w(profile)
        self._cruise_ms = profile.cruise_speed_ms
        # 平地・基準の路面より増えた重力と転がり抵抗（N）。風に依らない。
        self._gravity_extra_n = weight_n * grade
        self._rolling_extra_n = (rolling_crr - profile.crr) * weight_n
        # JITへ渡す値は型を揃える（配列は`kernel_array`、数はnumpyのfloat32）。
        self._constant_force = kernel_array(rolling_crr * weight_n + weight_n * grade, np.float32)
        self._drag_coefficient = np.float32(0.5 * _AIR_DENSITY_KG_M3 * profile.cda_m2)
        self._lowest_ms = np.float32(kmh_to_ms(tuning_value("speed.walking_kmh")))
        self._highest_ms = np.float32(kmh_to_ms(top_speed_kmh(profile.cruise_speed_kmh)))

    def ride(self, headwind_ms: np.ndarray, crosswind_ms: np.ndarray) -> SegmentRide:
        """区間ごとの走行速度（m/s）と、平地の出力を越えて踏んだ出力の内訳。`headwind_ms`は進行方向への向かい風成分
        （正が向かい風）、`crosswind_ms`は横成分。

        空気抵抗の増えた分は、巡航速度で走ったときの向かい風あり・なしの差で測る（速さに依らない基準で測り、踏む出力が
        解く速さに依らないようにする）。走行方程式`P = 抵抗力(v) × v`を`v`について解く。3次方程式になるため、二分法で
        挟んでから解を返す（ニュートン法は抵抗力が0を跨ぐ下り坂で発散しうるため、区間を確実に狭める方を採る）。
        """
        headwind = kernel_array(headwind_ms, np.float32)
        cross = kernel_array(crosswind_ms, np.float32)
        mismatched = {
            name: array.shape
            for name, array in (("headwind_ms", headwind), ("crosswind_ms", cross))
            if array.shape != self._shape
        }
        if mismatched:
            raise ValueError(f"区間の配列の長さが揃っていません grade={self._shape} {mismatched}")
        along = self._cruise_ms + headwind.astype(np.float64)
        air_extra_n = float(self._drag_coefficient) * (
            np.sqrt(along * along + cross.astype(np.float64) ** 2) * along - self._cruise_ms ** 2)
        extras = (self._gravity_extra_n, air_extra_n, self._rolling_extra_n)
        desired, power = pushed_power_w(self._flat_power_w, sum(extras))
        speeds = _segment_speeds(
            kernel_array(power, np.float32), self._constant_force, self._drag_coefficient, self._lowest_ms,
            self._highest_ms, headwind, cross,
        )
        positive = [np.maximum(extra, 0.0) for extra in extras]
        positive_sum = sum(positive)
        excess = power - self._flat_power_w
        shares = [np.divide(part, positive_sum, out=np.zeros_like(part), where=positive_sum > 0) for part in positive]
        return SegmentRide(
            speed_ms=speeds,
            gravity_extra_w=excess * shares[0], air_extra_w=excess * shares[1], rolling_extra_w=excess * shares[2],
            desired_ratio=desired / self._flat_power_w,
        )

    def speed_ms(self, headwind_ms: np.ndarray, crosswind_ms: np.ndarray) -> np.ndarray:
        """区間ごとの走行速度（m/s、float32。`ride`の速度だけ）。"""
        return self.ride(headwind_ms, crosswind_ms).speed_ms
