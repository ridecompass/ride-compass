"""費目の帳簿から、道1本と曲がる所の費用（秒）を組む式。

    費用 ＝ 避け方の倍率 ×［所要時間 ＋ つまみ ×（α × Σ 倍率 × 体力 ÷ 平地の出力 ＋ β × Σ 倍率 × 道のストレス）］

- 体力は、平地の出力を越えて踏んだJに、踏みたい出力（上限で切る前）と平地の出力の比の`γ`乗の重みを掛けたもの
  （`domain/cycling_speed.py: SegmentSpeedModel.ride`）。平地の出力で割ると「平地をその秒だけ走る体力」になる。
- 道のストレスは、道のストレスの軸（`domain/cost_axes.py: BurdenAxis`）の1kmあたりの重さ × km（重さ1の道に換算したkm）。βは
  換算したkm1つを何秒とみなすか。
- 倍率は軸ごと（費目と1対1）の利用者の値で、書いていない軸は標準の1。つまみは代償の全体に掛ける利用者の強さ。α・β・γは
  全部の軸に共通の換算なので較正値。どの項も0以上なので、費用は所要時間を下回らない（探索の見込みがそのまま使える）。

**欠けた材料は、取込の範囲全体の分布の平均で埋める**（`domain/road_network.py: MaterialFills`。探索の範囲には依らない）。区分の材料は区分ごとの
距離の割合で重さを平均し、数値の材料は距離で重みを付けた平均の値で引く。
"""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import cast

import numpy as np

from app.domain.attributes import CategoricalColumn, MaterialColumn
from app.domain.axis_templates import evaluate_breakpoint_linear
from app.domain.cost_preference import STANDARD_COST_FACTOR, CostPreference
from app.domain.cost_axes import EFFORT_AXES, Burden, CategoricalBurden, CostAxisDefinitions, EffortItem
from app.domain.cycling_speed import SegmentRide, SegmentSpeedModel
from app.domain.road_network import MaterialFills
from app.domain.tuning import tuning_value


#: 体力の費目 → 走りの内訳のその費目の欄（`EFFORT_AXES`の費目と1対1）。
_EFFORT_ITEM_J: dict[EffortItem, Callable[[SegmentRide], np.ndarray]] = {
    "gravity": lambda ride: ride.gravity_extra_j,
    "air": lambda ride: ride.air_extra_j,
    "inertia": lambda ride: ride.inertia_extra_j,
    "rolling": lambda ride: ride.rolling_extra_j,
}


@dataclass(frozen=True)
class LedgerParameters:
    """費用の式の利用者の値（つまみ・軸ごとの倍率）と較正値（α・β・γ）。"""

    #: 代償の全体に掛ける強さ（利用者のつまみの比 × 標準的な人の強さの較正値`evaluation.penalty_strength`）。
    effective_strength: float
    multipliers: Mapping[str, float]
    effort_alpha: float
    burden_seconds_per_km: float
    effort_weight_exponent: float

    def multiplier(self, axis_id: str) -> float:
        return self.multipliers.get(axis_id, STANDARD_COST_FACTOR)


def current_ledger_parameters(preference: CostPreference) -> LedgerParameters:
    """利用者の値`preference`と、いま効いている較正値で組む（呼ぶたびに読む——束ねると管理画面から変えた値が効かない）。
    つまみは標準的な人の強さ（較正値）に掛ける比。標準の人の値は`CostPreference()`で組む。"""
    return LedgerParameters(
        effective_strength=preference.strength * tuning_value("evaluation.penalty_strength"),
        multipliers=preference.multipliers,
        effort_alpha=tuning_value("cost.effort_alpha"),
        burden_seconds_per_km=tuning_value("cost.burden_seconds_per_km"),
        effort_weight_exponent=tuning_value("cost.effort_weight_exponent"),
    )


def burden_per_km(burden: Burden, materials: Mapping[str, MaterialColumn], fills: MaterialFills) -> np.ndarray:
    """道のストレスの軸の費目`burden`の、区間ごとの1kmあたりの重さ。`materials`は材料id→区間の列（数値の配列か区分の列）。
    材料の欠けた区間は取込の範囲全体の平均で埋める。"""
    if isinstance(burden, CategoricalBurden):
        weights = cast(CategoricalColumn, materials[burden.material]).lookup(burden.per_km)
        shares = fills.class_shares.get(burden.material, {})
        fill = sum(share * burden.per_km.get(value, 0.0) for value, share in shares.items())
        return np.where(np.isnan(weights), fill, weights)
    values = fills.fill(burden.material, cast(np.ndarray, materials[burden.material]))
    return np.nan_to_num(evaluate_breakpoint_linear(values, burden.points))


class LedgerCosts:
    """1回の生成の、道1本と曲がる所の代償の秒を組む。道のストレスは時刻に依らないので1回だけ求め、体力は風の時刻ごとに渡す。"""

    def __init__(self, axes: CostAxisDefinitions, parameters: LedgerParameters, flat_power_w: float, kickoff_j: float,
                 burden_per_km: Mapping[str, np.ndarray], distance_m: np.ndarray) -> None:
        """`flat_power_w`は平地の出力、`kickoff_j`は重みを掛けた漕ぎ出し1回の体力（`SegmentSpeedModel.kickoff_effort_j`）、
        `burden_per_km`は道のストレスの軸ごとの区間の1kmあたりの重さ（`domain/leg_costs.py: burden_weights`）、`distance_m`は区間の
        長さ。走行の模型から組むときは`for_model`。"""
        multiplier = parameters.multiplier
        self._weight_exponent = parameters.effort_weight_exponent
        self._item_multipliers = {item: multiplier(axis_id) for axis_id, item in EFFORT_AXES.items()}
        #: 体力1J（重み付き）あたりの代償の秒。区間の体力と曲がる所の漕ぎ出しに同じ換算で掛ける。
        self._seconds_per_j = parameters.effective_strength * parameters.effort_alpha / flat_power_w
        self._kickoff_seconds = self._seconds_per_j * self._item_multipliers["inertia"] * kickoff_j
        self._kickoff_axis_id = next(axis_id for axis_id, item in EFFORT_AXES.items() if item == "inertia")
        #: 道のストレスの軸ごとの、区間ごとの代償の秒（時刻に依らない）。
        distance_km = np.asarray(distance_m, dtype=np.float64) / 1000.0
        self._burden_axis_seconds = {
            axis_id: parameters.effective_strength * parameters.burden_seconds_per_km * multiplier(axis_id)
            * np.asarray(burden_per_km[axis_id], dtype=np.float64) * distance_km
            for axis_id in axes.burden
        }

    @classmethod
    def for_model(cls, axes: CostAxisDefinitions, parameters: LedgerParameters, model: SegmentSpeedModel,
                  burden_per_km: Mapping[str, np.ndarray]) -> "LedgerCosts":
        """走行の模型`model`の平地の出力・漕ぎ出しの体力（式の重み`γ`を掛けたもの）・区間の長さと、道のストレスの軸ごとの区間の
        1kmあたりの重さ（`domain/leg_costs.py: burden_weights`）で組む。"""
        return cls(axes, parameters, model.flat_power_w, model.kickoff_effort_j(parameters.effort_weight_exponent),
                   burden_per_km, model.distance_m)

    def penalty_by_axis(self, ride: SegmentRide, rows: np.ndarray | None = None) -> dict[str, np.ndarray]:
        """軸id → 区間ごとの代償の秒（体力の軸は つまみ × α × 倍率 × 体力 ÷ 平地の出力、道のストレスの軸は つまみ × β × 倍率 ×
        重さ×km）。体力の軸を`EFFORT_AXES`の順、続けて道のストレスの軸で、和が`penalty_seconds`。`ride`は重みを掛けた体力の内訳で、
        区間の行`rows`だけを走ったもの（`domain/cycling_speed.py: SegmentSpeedModel.ride`に`rows`を渡したもの）なら`rows`も渡す。"""
        effort = {
            axis_id: self._seconds_per_j * self._item_multipliers[item] * _EFFORT_ITEM_J[item](ride)
            for axis_id, item in EFFORT_AXES.items()
        }
        burden = self._burden_axis_seconds if rows is None else {
            axis_id: seconds[rows] for axis_id, seconds in self._burden_axis_seconds.items()}
        return effort | burden

    def penalty_seconds(self, ride: SegmentRide) -> np.ndarray:
        """区間ごとの代償の秒（所要時間に足す分。つまみ × (α × 体力 ＋ 道のストレス)）。`ride`は重みを掛けた体力の内訳。"""
        return np.asarray(sum(self.penalty_by_axis(ride).values(), np.zeros(len(ride.seconds))), dtype=np.float64)

    def row_seconds(self, model: SegmentSpeedModel, headwind_ms: np.ndarray, crosswind_ms: np.ndarray,
                    rows: np.ndarray | None = None) -> tuple[np.ndarray, dict[str, np.ndarray]]:
        """区間の行`rows`（省略すると全部）だけを風の成分（`rows`の並び）で走ったときの`(走行時間, 軸ごとの代償の秒)`
        （`penalty_by_axis`）。"""
        ride = model.ride(headwind_ms, crosswind_ms, self._weight_exponent, rows)
        return ride.seconds, self.penalty_by_axis(ride, rows)

    def turn_penalty_by_axis(self, kickoffs: float) -> dict[str, float]:
        """曲がる所の漕ぎ出し`kickoffs`回の代償の秒を、その費目（慣性）を持つ軸へ（軸id → 秒）。曲がる所の損は、その軸の損の
        うち通る道筋で決まる分で、軸と別の行を持たない。"""
        return {self._kickoff_axis_id: kickoffs * self._kickoff_seconds}

    def bin_seconds(self, model: SegmentSpeedModel, headwind_ms: np.ndarray,
                    crosswind_ms: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """風の成分で走ったときの、区間ごとの`(走行時間, 代償の秒)`（体力の重みは式の`γ`で掛ける）。"""
        ride = model.ride(headwind_ms, crosswind_ms, self._weight_exponent)
        return ride.seconds, self.penalty_seconds(ride)

    def transition_costs(self, turn_seconds: np.ndarray, turn_kickoffs: np.ndarray) -> np.ndarray:
        """曲がる所の費用（秒、遷移ごと。`turn_seconds`の型のまま）: 時間に、漕ぎ出しの回数 × 漕ぎ出し1回の代償を足したもの。
        区間の止まる出来事と同じ換算。"""
        if self._kickoff_seconds == 0.0:
            return turn_seconds
        return turn_seconds + turn_kickoffs * turn_seconds.dtype.type(self._kickoff_seconds)
