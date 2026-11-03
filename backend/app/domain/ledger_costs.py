"""費目の帳簿から、道1本と曲がる所の費用（秒）を組む式。

    費用 ＝ 避け方の倍率 ×［所要時間 ＋ つまみ ×（α × Σ 倍率 × 体力 ÷ 平地の出力 ＋ β × Σ 倍率 × 道の負担）］

- 体力は、平地の出力を越えて踏んだJに、踏みたい出力（上限で切る前）と平地の出力の比の`γ`乗の重みを掛けたもの
  （`domain/cycling_speed.py: SegmentSpeedModel.ride`）。平地の出力で割ると「平地をその秒だけ走る体力」になる。
- 道の負担は、道の負担の軸（`domain/cost_axes.py: BurdenAxis`）の1kmあたりの重さ × km（重さ1の道に換算したkm）。βは
  換算したkm1つを何秒とみなすか。
- 倍率は軸ごと（費目と1対1）の利用者の値で、書いていない軸は標準の1。つまみは代償の全体に掛ける利用者の強さ。α・β・γは
  全部の軸に共通の換算なので較正値。どの項も0以上なので、費用は所要時間を下回らない（探索の見込みがそのまま使える）。

**欠けた材料は、取込の範囲全体の分布の平均で埋める**（`MaterialFills`。探索の範囲には依らない）。区分の材料は区分ごとの
距離の割合で重さを平均し、数値の材料は距離で重みを付けた平均の値で引く。
"""

from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np

from app.domain.attributes import CategoricalColumn
from app.domain.cost_axes import EFFORT_AXES, CategoricalBurden, CostAxisDefinitions
from app.domain.cycling_speed import RiderProfile, SegmentRide, kickoff_extra_j, wheel_power_w
from app.domain.tuning import tuning_value


@dataclass(frozen=True)
class MaterialFills:
    """取込の範囲全体の材料の分布（欠けを埋める平均）。`numeric_means`は数値の材料の距離で重みを付けた平均、`class_shares`は
    区分の材料の値ごとの距離の割合（値の無い道を除いて和が1）。"""

    numeric_means: Mapping[str, float]
    class_shares: Mapping[str, Mapping[str, float]]


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


def burden_per_km(axes: CostAxisDefinitions, axis_id: str, numeric: Mapping[str, np.ndarray],
                  categorical: Mapping[str, CategoricalColumn], fills: MaterialFills) -> np.ndarray:
    """道の負担の軸`axis_id`の、区間ごとの1kmあたりの重さ。材料の欠けた区間は取込の範囲全体の平均で埋める。"""
    burden = axes.burden[axis_id].burden
    if isinstance(burden, CategoricalBurden):
        weights = categorical[burden.material].lookup(burden.per_km)
        shares = fills.class_shares.get(burden.material, {})
        fill = sum(share * burden.per_km.get(value, 0.0) for value, share in shares.items())
        return np.where(np.isnan(weights), fill, weights)
    values = np.asarray(numeric[burden.material], dtype=np.float64)
    values = np.where(np.isnan(values), fills.numeric_means.get(burden.material, np.nan), values)
    xs, ys = zip(*burden.points)
    return np.nan_to_num(np.interp(values, xs, ys))


class LedgerCosts:
    """1回の生成の、道1本と曲がる所の代償の秒を組む。道の負担は時刻に依らないので1回だけ求め、体力は風の時刻ごとに渡す。"""

    def __init__(self, axes: CostAxisDefinitions, parameters: LedgerParameters, profile: RiderProfile,
                 burden_km: Mapping[str, np.ndarray]) -> None:
        """`burden_km`は道の負担の軸ごとの区間の重さ×km（`burden_per_km` × 区間の長さkm）。"""
        self._parameters = parameters
        self._flat_power_w = wheel_power_w(profile)
        self._kickoff_j = kickoff_extra_j(profile)
        self._kickoff_weight = tuning_value("speed.max_climb_power_ratio") ** parameters.effort_weight_exponent
        multiplier = parameters.multiplier
        self._burden_seconds = parameters.burden_seconds_per_km * sum(
            (multiplier(axis_id) * np.asarray(burden_km[axis_id], dtype=np.float64) for axis_id in axes.burden), 0.0)
        self._item_multipliers = {item: multiplier(axis_id) for axis_id, item in EFFORT_AXES.items()}

    @property
    def effort_weight_exponent(self) -> float:
        return self._parameters.effort_weight_exponent

    def penalty_seconds(self, ride: SegmentRide) -> np.ndarray:
        """区間ごとの代償の秒（所要時間に足す分。つまみ × (α × 体力 ＋ 道の負担)）。`ride`は重みを掛けた体力の内訳。"""
        m = self._item_multipliers
        effort_j = (m["gravity"] * ride.gravity_extra_j + m["air"] * ride.air_extra_j
                    + m["rolling"] * ride.rolling_extra_j + m["inertia"] * ride.inertia_extra_j * self._kickoff_weight)
        effort_seconds = self._parameters.effort_alpha * effort_j / self._flat_power_w
        return self._parameters.strength * (effort_seconds + self._burden_seconds)

    def transition_costs(self, turn_seconds: np.ndarray, turn_kickoffs: np.ndarray) -> np.ndarray:
        """曲がる所の費用（秒）: 時間に、漕ぎ出しの代償（停止の軸の倍率 × 回数 × 漕ぎ出しの体力の重み付き ÷ 平地の出力）を
        足したもの。区間の止まる出来事と同じ換算。"""
        per_kickoff = (self._parameters.strength * self._parameters.effort_alpha * self._item_multipliers["inertia"]
                       * self._kickoff_j * self._kickoff_weight / self._flat_power_w)
        return (np.asarray(turn_seconds, dtype=np.float64) + per_kickoff * np.asarray(turn_kickoffs, dtype=np.float64)
                ).astype(np.asarray(turn_seconds).dtype)

