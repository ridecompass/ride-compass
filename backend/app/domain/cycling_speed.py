"""自転車の走行モデル（所要時間の物理）。

区間ごとの速度は走行方程式で決まる:

    ホイール出力 P = ( 空気抵抗 + 転がり抵抗 + 重力 ) × 速度
    空気抵抗 = ½ × ρ × CdA × (速度 + 向かい風)²
    転がり抵抗 = Crr × 質量 × g
    重力     = 質量 × g × 勾配

利用者から取る入力は**平地・無風の巡航速度**だけで、そこからホイール出力を逆算する
（`wheel_power_w`）。体重・出力・ケイデンスは一般の利用者が答えられないため、CdA・Crr・質量は
標準値を使う。「向かい風に強い／弱い」の差の多くは巡航速度の違いとして式から出る——同じ
向かい風5m/sでも、巡航20km/hの人は42%、30km/hの人は33%しか落ちない。

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
from app.domain.traffic import stop_count_material_ids
from app.domain.tuning import TUNING_PARAMETERS_BY_ID, tuning_value
from app.domain.wind import kmh_to_ms

AIR_DENSITY_KG_M3 = 1.225
GRAVITY_M_S2 = 9.80665

# 走ってみて決める値（CdA・Crr・質量・速度の上下限・登りの出力の増え方等）は
# `domain/tuning.py`が宣言し、ここでは読むだけにする。定数として持つと、宣言と二重に
# なったうえ管理画面からの変更が効かない。

# 速度を挟み込む二分法の反復回数。初期区間は押して歩く速度〜速度の上限（`top_speed_kmh`。巡航速度の上限は
# `domain/route_request.py: MAX_ASSUMED_SPEED_KMH`）で、12回で幅は初期区間の4096分の1（巡航速度が上限でも0.01km/h程度）まで縮む。粗くすると平地・無風で巡航速度に一致しなくなる。
SPEED_SOLVE_ITERATIONS = 12

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
    drag = 0.5 * AIR_DENSITY_KG_M3 * profile.cda_m2 * speed * speed
    rolling = profile.crr * profile.mass_kg * GRAVITY_M_S2
    return (drag + rolling) * speed


def climb_power_w(flat_power_w: float, grade: np.ndarray) -> np.ndarray:
    """区間ごとに踏む出力（W）。登りでは勾配1%ごとに決まったWを足し、平地の出力の上限倍率で止まる
    （下り・平地は平地の出力のまま）。

    一定出力で計算すると平地20km/hの人が勾配5%で時速4.6km＝押して歩く速度になり現実と
    合わないため、勾配に比例して踏む量を増やす。足す量を平地の出力に比例させない——比例させると
    巡航が速い人ほど登りで踏み増し、坂でも平地並みの速度を保って所要時間が短く出る。
    """
    extra = tuning_value("speed.climb_power_per_grade") * np.maximum(grade, 0.0) * 100.0
    return np.minimum(flat_power_w + extra, flat_power_w * tuning_value("speed.max_climb_power_ratio"))


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
        for _ in range(SPEED_SOLVE_ITERATIONS):
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


class SegmentSpeedModel:
    """区間ごとの走行モデルのうち、風に依らない部分（出力・速度に依らない抵抗・挟み込みの初期区間）を
    先に1回だけ求めたもの。風の成分を渡すたびに速度を解く。

    時刻ビンごとに変わるのは風だけなので、ルート生成は探索範囲に1回作ってビンの数だけ解く。
    較正値は作った時点で読む。**配列はすべて`grade`と同じ長さで渡す**——長さの違う配列を区間の番号で
    読み違えないよう、揃っていることをここで確かめる。
    """

    def __init__(self, profile: RiderProfile, grade: np.ndarray, crr: np.ndarray) -> None:
        """`grade`は勾配（0.05なら5%）、`crr`は区間ごとの転がり抵抗（`crr_for_surface`）。"""
        grade = np.asarray(grade, dtype=np.float32)
        rolling_crr = np.asarray(crr, dtype=np.float32)
        if rolling_crr.shape != grade.shape:
            raise ValueError(f"区間の配列の長さが揃っていません grade={grade.shape} crr={rolling_crr.shape}")
        self._shape = grade.shape
        # JITへ渡す配列と値は型（dtype・C順・書き込み可）を揃える。型ごとに別にコンパイルされ、イメージで焼いた
        # 結果（`domain/routing.py: compile_search_kernels`）と違う型は、本番の最初の生成でコンパイルを払う。
        self._power = np.array(climb_power_w(wheel_power_w(profile), grade), dtype=np.float32)
        weight_n = np.float32(profile.mass_kg * GRAVITY_M_S2)
        self._constant_force = np.array(rolling_crr * weight_n + weight_n * grade, dtype=np.float32)
        self._drag_coefficient = np.float32(0.5 * AIR_DENSITY_KG_M3 * profile.cda_m2)
        self._lowest_ms = np.float32(kmh_to_ms(tuning_value("speed.walking_kmh")))
        self._highest_ms = np.float32(kmh_to_ms(top_speed_kmh(profile.cruise_speed_kmh)))

    def speed_ms(self, headwind_ms: np.ndarray, crosswind_ms: np.ndarray) -> np.ndarray:
        """区間ごとの走行速度（m/s、float32）。`headwind_ms`は進行方向への向かい風成分（正が向かい風）、
        `crosswind_ms`は横成分。

        走行方程式`P = 抵抗力(v) × v`を`v`について解く。3次方程式になるため、二分法で挟んでから
        解を返す（ニュートン法は抵抗力が0を跨ぐ下り坂で発散しうるため、区間を確実に狭める方を採る）。
        """
        headwind = np.ascontiguousarray(headwind_ms, dtype=np.float32)
        cross = np.ascontiguousarray(crosswind_ms, dtype=np.float32)
        mismatched = {
            name: array.shape
            for name, array in (("headwind_ms", headwind), ("crosswind_ms", cross))
            if array.shape != self._shape
        }
        if mismatched:
            raise ValueError(f"区間の配列の長さが揃っていません grade={self._shape} {mismatched}")
        return _segment_speeds(
            self._power, self._constant_force, self._drag_coefficient, self._lowest_ms, self._highest_ms,
            headwind if headwind.flags.writeable else headwind.copy(),
            cross if cross.flags.writeable else cross.copy(),
        )
