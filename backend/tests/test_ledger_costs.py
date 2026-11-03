"""`domain/ledger_costs.py`——費目の帳簿から、道1本と曲がる所の費用（秒）を組む式と、欠けた材料の埋め方。

入口は`burden_per_km`・`LedgerCosts`（`penalty_seconds`・`transition_costs`）と、合成（`LegCostComposer`）が新しい式で組む費用。

ここで見ないもの:
- 体力の内訳と重みそのもの → `test_cycling_speed.py`
- 軸の定義の形と検証 → `test_cost_axes.py`
"""

import numpy as np
import pytest

from app.domain.attributes import CategoricalColumn
from app.domain.cost_axes import EFFORT_AXES, CostAxisDefinitions
from app.domain.cycling_speed import RiderProfile, SegmentRide, kickoff_extra_j, wheel_power_w
from app.domain.ledger_costs import LedgerCosts, LedgerParameters, burden_per_km
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.road_network import MaterialFills

RIDER = RiderProfile(cruise_speed_kmh=20.0)
LENS = {"thresholds": [1.0], "band_labels": ["a", "b"]}
VIBRATION = "class:surface_estimate"


def _axes(**burden) -> CostAxisDefinitions:
    presentation = {"label": "x", "description": "", "icon_id": "i", "lens": LENS}
    return CostAxisDefinitions.model_validate({
        "effort": {axis_id: presentation for axis_id in EFFORT_AXES},
        "burden": {axis_id: {**presentation, "burden": b} for axis_id, b in burden.items()},
        "total_lens": presentation,
    })


AXES = _axes(vibration={"kind": "categorical", "material": VIBRATION, "per_km": {"paved": 0.0, "gravel": 1.0}})


def _parameters(strength=1.0, alpha=1.0, beta=180.0, exponent=0.0, **multipliers) -> LedgerParameters:
    return LedgerParameters(effective_strength=strength, multipliers=multipliers, effort_alpha=alpha,
                            burden_seconds_per_km=beta, effort_weight_exponent=exponent)


def _ledger(parameters: LedgerParameters, vibration_km: list[float]) -> LedgerCosts:
    return LedgerCosts(AXES, parameters, wheel_power_w(RIDER), kickoff_extra_j(RIDER), {"vibration": np.array(vibration_km)},
                       np.full(len(vibration_km), 1000.0))


def _ride(n: int, gravity=0.0, air=0.0, rolling=0.0, inertia=0.0) -> SegmentRide:
    def column(value):
        return np.full(n, float(value))
    return SegmentRide(seconds=column(100.0), gravity_extra_j=column(gravity), air_extra_j=column(air),
                       rolling_extra_j=column(rolling), inertia_extra_j=column(inertia))


def test_the_penalty_is_the_strength_times_the_effort_over_the_flat_power_and_the_burden_in_seconds():
    """代償 ＝ つまみ ×（α × Σ 倍率 × 体力 ÷ 平地の出力 ＋ β × Σ 倍率 × 道の負担）。倍率は軸ごとで、書いていない軸は1。"""
    flat = wheel_power_w(RIDER)
    ledger = _ledger(_parameters(strength=0.5, alpha=2.0, beta=100.0, ascent=3.0, vibration=2.0), [0.4])

    penalty = ledger.penalty_seconds(_ride(1, gravity=1000.0, air=500.0))

    expected = 0.5 * (2.0 * (3.0 * 1000.0 + 1.0 * 500.0) / flat + 100.0 * 2.0 * 0.4)
    assert penalty.tolist() == pytest.approx([expected])


def test_an_axis_with_a_zero_multiplier_adds_nothing_and_the_penalty_never_goes_negative():
    """倍率0の軸は数えない。どの項も0以上なので、費用は所要時間を下回らない（探索の見込みがそのまま使える）。"""
    ledger = _ledger(_parameters(ascent=0.0, vibration=0.0), [1.0])

    assert ledger.penalty_seconds(_ride(1, gravity=5000.0)).tolist() == [0.0]


def test_a_turn_costs_its_time_and_the_kickoffs_like_a_stop_on_a_road():
    """曲がる所の費用は、時間に漕ぎ出しの回数 × 漕ぎ出しの代償を足したもの。区間の止まる出来事（慣性の費目）と同じ換算。"""
    ledger = _ledger(_parameters(strength=2.0, stopping=1.5), [0.0])
    one_stop_on_a_road = ledger.penalty_seconds(_ride(1, inertia=kickoff_extra_j(RIDER)))[0]

    costs = ledger.transition_costs(np.array([10.0, 0.0], dtype=np.float32), np.array([1.0, 0.0], dtype=np.float32))

    assert costs.tolist() == pytest.approx([10.0 + one_stop_on_a_road, 0.0])


def test_a_road_without_a_surface_class_carries_the_mean_burden_of_the_whole_network():
    """区分の無い道の重さは、取込の範囲全体の区分の割合で平均した重さ（探索の範囲に依らない）。"""
    column = CategoricalColumn.encode(["gravel", None, "paved"])
    fills = MaterialFills(numeric_means={}, class_shares={VIBRATION: {"paved": 0.75, "gravel": 0.25}})

    weights = burden_per_km(AXES.burden["vibration"].burden, {VIBRATION: column}, fills)

    assert weights.tolist() == pytest.approx([1.0, 0.25, 0.0])


def test_a_curve_reads_the_material_and_a_missing_value_reads_the_mean_of_the_whole_network():
    axes = _axes(steep={"kind": "linear", "material": GRADIENT_PERCENT, "points": [[0.0, 0.0], [10.0, 1.0]]})
    fills = MaterialFills(numeric_means={GRADIENT_PERCENT: 5.0}, class_shares={})

    weights = burden_per_km(axes.burden["steep"].burden, {GRADIENT_PERCENT: np.array([2.0, np.nan, 20.0])}, fills)

    assert weights.tolist() == pytest.approx([0.2, 0.5, 1.0])
