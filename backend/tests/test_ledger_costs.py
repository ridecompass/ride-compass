"""`domain/ledger_costs.py`——費目の帳簿から、道1本と曲がる所の費用（秒）を組む式と、欠けた材料の埋め方。

入口は`burden_weights`・`LedgerCosts`（`penalty_seconds`・`transition_costs`）と、合成（`LegCostComposer`）が新しい式で組む費用。

ここで見ないもの:
- 体力の内訳と重みそのもの → `test_cycling_speed.py`
- 軸の定義の形と検証 → `test_cost_axes.py`
"""

import numpy as np
import pytest

from app.domain.attributes import CategoricalColumn
from app.domain.cost_axes import EFFORT_AXES, CostAxisDefinitions
from app.domain.cycling_speed import RiderProfile, SegmentRide, kickoff_extra_j, wheel_power_w
from app.domain.leg_costs import burden_fills, burden_weights
from app.domain.cost_preference import CostPreference
from app.domain.ledger_costs import LedgerCosts, LedgerParameters, ledger_parameters
from app.domain.material_catalog import GRADIENT_PERCENT
from tests.tuning_fixture import TUNED

#: 道のストレスの軸の材料の欠けを埋める重さ（材料の無い道は無い）。
NO_FILLS = {"vibration": 0.0}

RIDER = RiderProfile.standard(20.0, TUNED)
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


def _parameters(strength=1.0, alpha=1.0, beta=180.0, exponent=0.0, disabled=(), **multipliers) -> LedgerParameters:
    return LedgerParameters(strength=strength, multipliers=multipliers, effort_alpha=alpha,
                            burden_seconds_per_km=beta, effort_weight_exponent=exponent,
                            counts=CostPreference(disabled_axes=list(disabled)).counts)


def _ledger(parameters: LedgerParameters, vibration_km: list[float]) -> LedgerCosts:
    return LedgerCosts(parameters, wheel_power_w(RIDER), kickoff_extra_j(RIDER, TUNED), {"vibration": np.array(vibration_km)},
                       np.full(len(vibration_km), 1000.0))


def _ride(n: int, gravity=0.0, air=0.0, rolling=0.0, inertia=0.0) -> SegmentRide:
    def column(value):
        return np.full(n, float(value))
    return SegmentRide(seconds=column(100.0), gravity_extra_j=column(gravity), air_extra_j=column(air),
                       rolling_extra_j=column(rolling), inertia_extra_j=column(inertia))


def test_the_penalty_is_the_strength_times_the_effort_over_the_flat_power_and_the_burden_in_seconds():
    """代償 ＝ つまみ ×（α × Σ 倍率 × 体力 ÷ 平地の出力 ＋ β × Σ 倍率 × 道のストレス）。倍率は軸ごとで、書いていない軸は1。"""
    flat = wheel_power_w(RIDER)
    ledger = _ledger(_parameters(strength=0.5, alpha=2.0, beta=100.0, ascent=3.0, vibration=2.0), [0.4])

    penalty = ledger.penalty_seconds(_ride(1, gravity=1000.0, air=500.0))

    expected = 0.5 * (2.0 * (3.0 * 1000.0 + 1.0 * 500.0) / flat + 100.0 * 2.0 * 0.4)
    assert penalty.tolist() == pytest.approx([expected])


def test_a_disabled_axis_is_not_built_and_a_disabled_stop_axis_does_not_count_the_turns_either():
    """無効の軸は組まず、軸ごとの秒にも和にも入らない（道のストレスの軸は、区間ごとの重さを作る所で落ちる）。停止（慣性の費目）を
    無効にすると、曲がる所の漕ぎ出しも数えず、曲がる所の費用は時間だけになる。"""
    parameters = _parameters(disabled=("ascent", "vibration", "stopping"))
    weights = burden_weights(AXES, parameters, {VIBRATION: CategoricalColumn.encode(["gravel"])}, NO_FILLS)
    ledger = LedgerCosts(parameters, wheel_power_w(RIDER), kickoff_extra_j(RIDER, TUNED), weights, np.full(1, 1000.0))
    ride = _ride(1, gravity=5000.0, inertia=kickoff_extra_j(RIDER, TUNED))

    assert set(ledger.penalty_by_axis(ride)) == {"headwind", "friction"}
    assert ledger.penalty_seconds(ride).tolist() == [0.0]
    assert ledger.turn_penalty_by_axis(2.0) == {}
    assert ledger.transition_costs(np.array([10.0], dtype=np.float32), np.array([1.0], dtype=np.float32)).tolist() == [10.0]


def test_with_the_strength_off_no_axis_is_built():
    """走りにくさの全体の割合を無効（0）にすると、全部の軸を無効にしたのと同じく、どの軸も組まない（内訳にも地図のレンズにも出ない）。"""
    parameters = ledger_parameters(CostPreference(strength=0.0), TUNED)
    weights = burden_weights(AXES, parameters, {VIBRATION: CategoricalColumn.encode(["gravel"])}, NO_FILLS)
    ledger = LedgerCosts(parameters, wheel_power_w(RIDER), kickoff_extra_j(RIDER, TUNED), weights, np.full(1, 1000.0))
    ride = _ride(1, gravity=5000.0, inertia=kickoff_extra_j(RIDER, TUNED))

    assert ledger.penalty_by_axis(ride) == {}
    assert ledger.turn_penalty_by_axis(2.0) == {}


def test_a_turn_costs_its_search_seconds_and_the_kickoffs_like_a_stop_on_a_road():
    """曲がる所の費用は、探索の重み（時間と罰）に漕ぎ出しの回数 × 漕ぎ出しの代償を足したもの。区間の止まる出来事（慣性の費目）と
    同じ換算。"""
    ledger = _ledger(_parameters(strength=2.0, stopping=1.5), [0.0])
    one_stop_on_a_road = ledger.penalty_seconds(_ride(1, inertia=kickoff_extra_j(RIDER, TUNED)))[0]

    costs = ledger.transition_costs(np.array([10.0, 0.0], dtype=np.float32), np.array([1.0, 0.0], dtype=np.float32))

    assert costs.tolist() == pytest.approx([10.0 + one_stop_on_a_road, 0.0])


@pytest.mark.parametrize(("burden", "column"), [
    ({"kind": "categorical", "material": VIBRATION, "per_km": {"paved": 0.0, "gravel": 1.0}},
     CategoricalColumn.encode(["gravel", None, "paved"])),
    ({"kind": "linear", "material": GRADIENT_PERCENT, "points": [[0.0, 0.0], [10.0, 1.0]]}, np.array([20.0, np.nan, 0.0])),
])
def test_a_road_without_the_material_carries_the_given_weight_and_the_others_read_their_material(burden, column):
    """材料の無い道は取込の範囲全体の重さの平均（`domain/leg_costs.py: burden_fills`）で、ほかの道は自分の材料の重さ
    （数値の材料は折れ線の範囲の外を端の重さ）で数える。"""
    weights = burden_weights(_axes(axis=burden), _parameters(), {burden["material"]: column}, {"axis": 0.25})

    assert weights["axis"].tolist() == pytest.approx([1.0, 0.25, 0.0])


def test_a_missing_material_is_filled_with_the_mean_weight_of_the_roads_that_have_it():
    """欠けを埋める重さは、材料のある道の重さの距離で重みを付けた平均。材料の値を平均してから重さにしない——折れ線が頭打ちになる
    所で、値の平均の重さは道の重さの平均を上回り、材料の無い道を重く見る。道路網に列の無い材料の軸は0。"""
    axes = _axes(
        by_class={"kind": "categorical", "material": VIBRATION, "per_km": {"paved": 0.0, "gravel": 1.0}},
        by_value={"kind": "linear", "material": GRADIENT_PERCENT, "points": [[0.0, 0.0], [20.0, 1.0]]},
        absent={"kind": "linear", "material": "num_absent", "points": [[0.0, 0.0], [1.0, 1.0]]},
    )
    columns = {
        VIBRATION: CategoricalColumn.encode(["gravel", None, "paved", "paved"]),
        # 重さは0.5・NaN・1・1（値の平均は32.5で、重さは1）。
        GRADIENT_PERCENT: np.array([10.0, np.nan, 40.0, 40.0]),
        "num_absent": None,
    }

    fills = burden_fills({axis_id: axis.burden for axis_id, axis in axes.burden.items()}, columns,
                         np.array([100.0, 500.0, 100.0, 200.0]))

    assert fills == pytest.approx({"by_class": 100.0 / 400.0, "by_value": (0.5 * 100.0 + 300.0) / 400.0, "absent": 0.0})
