"""費目の帳簿から、道1本と曲がる所の費用（秒）を組む式。

    費用 ＝ 避け方の倍率 ×［所要時間 ＋ つまみ ×（α × Σ 倍率 × 体力 ÷ 平地の出力 ＋ β × Σ 倍率 × 道の負担）］

- 体力は、平地の出力を越えて踏んだJに、踏みたい出力（上限で切る前）と平地の出力の比の`γ`乗の重みを掛けたもの
  （`domain/cycling_speed.py: SegmentSpeedModel.ride`）。平地の出力で割ると「平地をその秒だけ走る体力」になる。
- 道の負担は、道の負担の軸（`domain/cost_axes.py: BurdenAxis`）の1kmあたりの重さ × km（重さ1の道に換算したkm）。βは
  換算したkm1つを何秒とみなすか。
- 倍率は軸ごと（費目と1対1）の利用者の値で、書いていない軸は標準の1。つまみは代償の全体に掛ける利用者の強さ。α・β・γは
  全部の軸に共通の換算なので較正値。どの項も0以上なので、費用は所要時間を下回らない（探索の見込みがそのまま使える）。

**欠けた材料は、取込の範囲全体の分布の平均で埋める**（`domain/road_network.py: MaterialFills`。探索の範囲には依らない）。区分の材料は区分ごとの
距離の割合で重さを平均し、数値の材料は距離で重みを付けた平均の値で引く。
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import cast

import numpy as np

from app.domain.attributes import CategoricalColumn, MaterialColumn
from app.domain.axis_templates import evaluate_breakpoint_linear
from app.domain.cost_axes import EFFORT_AXES, Burden, EffortItem, CategoricalBurden, CostAxisDefinitions
from app.domain.cycling_speed import SegmentRide, SegmentSpeedModel
from app.domain.road_network import MaterialFills
from app.domain.tuning import tuning_value


@dataclass(frozen=True)
class LedgerParameters:
    """費用の式の利用者の値（つまみ・軸ごとの倍率）と較正値（α・β・γ）。"""

    strength: float
    multipliers: Mapping[str, float]
    effort_alpha: float
    burden_seconds_per_km: float
    effort_weight_exponent: float

    def multiplier(self, axis_id: str) -> float:
        return self.multipliers.get(axis_id, 1.0)


def current_ledger_parameters(strength: float, multipliers: Mapping[str, float]) -> LedgerParameters:
    """いま効いている較正値で組む（呼ぶたびに読む——束ねると管理画面から変えた値が効かない）。"""
    return LedgerParameters(
        strength=strength, multipliers=multipliers,
        effort_alpha=tuning_value("cost.effort_alpha"),
        burden_seconds_per_km=tuning_value("cost.burden_seconds_per_km"),
        effort_weight_exponent=tuning_value("cost.effort_weight_exponent"),
    )


def standard_ledger_parameters() -> LedgerParameters:
    """つまみ1（割増の強さの較正値そのもの）・倍率はどの軸も標準の1の値。利用者の値が届かない所（地図のレンズ・凡例の目安）が
    読む。"""
    return current_ledger_parameters(tuning_value("evaluation.penalty_strength"), {})


def burden_per_km(burden: Burden, materials: Mapping[str, MaterialColumn], fills: MaterialFills) -> np.ndarray:
    """道の負担の軸の費目`burden`の、区間ごとの1kmあたりの重さ。`materials`は材料id→区間の列（数値の配列か区分の列）。
    材料の欠けた区間は取込の範囲全体の平均で埋める。"""
    if isinstance(burden, CategoricalBurden):
        weights = cast(CategoricalColumn, materials[burden.material]).lookup(burden.per_km)
        shares = fills.class_shares.get(burden.material, {})
        fill = sum(share * burden.per_km.get(value, 0.0) for value, share in shares.items())
        return np.where(np.isnan(weights), fill, weights)
    values = fills.fill(burden.material, cast(np.ndarray, materials[burden.material]))
    return np.nan_to_num(evaluate_breakpoint_linear(values, burden.points))


def _effort_extra_j(ride: SegmentRide, item: EffortItem) -> np.ndarray:
    """体力の費目`item`の、区間ごとの平地の出力を越えて踏んだ体力（`SegmentRide`の欄との対応はここだけが持つ）。"""
    return {"gravity": ride.gravity_extra_j, "air": ride.air_extra_j, "inertia": ride.inertia_extra_j,
            "rolling": ride.rolling_extra_j}[item]


class LedgerCosts:
    """1回の生成の、道1本と曲がる所の代償の秒を組む。道の負担は時刻に依らないので1回だけ求め、体力は風の時刻ごとに渡す。"""

    def __init__(self, axes: CostAxisDefinitions, parameters: LedgerParameters, flat_power_w: float, kickoff_j: float,
                 burden_km: Mapping[str, np.ndarray]) -> None:
        """`flat_power_w`は平地の出力、`kickoff_j`は重みを掛けた漕ぎ出し1回の体力（`SegmentSpeedModel.kickoff_effort_j`）、
        `burden_km`は道の負担の軸ごとの区間の重さ×km（`burden_per_km` × 区間の長さkm）。"""
        multiplier = parameters.multiplier
        self._weight_exponent = parameters.effort_weight_exponent
        self._item_multipliers = {item: multiplier(axis_id) for axis_id, item in EFFORT_AXES.items()}
        #: 体力1J（重み付き）あたりの代償の秒。区間の体力と曲がる所の漕ぎ出しに同じ換算で掛ける。
        self._seconds_per_j = parameters.strength * parameters.effort_alpha / flat_power_w
        self._kickoff_seconds = self._seconds_per_j * self._item_multipliers["inertia"] * kickoff_j
        seconds_per_km = parameters.strength * parameters.burden_seconds_per_km
        #: 道の負担の軸ごとの、区間の代償の秒（時刻に依らない）。
        self._burden_axis_seconds = {
            axis_id: seconds_per_km * multiplier(axis_id) * np.asarray(burden_km[axis_id], dtype=np.float64)
            for axis_id in axes.burden}

    @classmethod
    def for_model(cls, axes: CostAxisDefinitions, parameters: LedgerParameters, model: SegmentSpeedModel,
                  burden_km: Mapping[str, np.ndarray]) -> "LedgerCosts":
        """走行の模型`model`の平地の出力と漕ぎ出しの体力（式の重み`γ`を掛けたもの）で組む。"""
        return cls(axes, parameters, model.flat_power_w, model.kickoff_effort_j(parameters.effort_weight_exponent),
                   burden_km)

    def penalty_seconds(self, ride: SegmentRide) -> np.ndarray:
        """区間ごとの代償の秒（所要時間に足す分。つまみ × (α × 体力 ＋ 道の負担)）。`ride`は重みを掛けた体力の内訳。"""
        return sum(self.penalty_by_axis(ride).values(), np.zeros(np.shape(ride.seconds)))

    def penalty_by_axis(self, ride: SegmentRide) -> dict[str, np.ndarray]:
        """区間ごとの代償の秒の、軸ごとの内訳（体力の軸をコードの表の順、続けて道の負担の軸。和が`penalty_seconds`）。"""
        effort = {axis_id: self._seconds_per_j * self._item_multipliers[item] * _effort_extra_j(ride, item)
                  for axis_id, item in EFFORT_AXES.items()}
        return {**effort, **self._burden_axis_seconds}

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
