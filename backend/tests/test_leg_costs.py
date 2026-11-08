"""`domain/leg_costs.py`——探索範囲の材料の表・費用の軸の定義・0次フィルタ・風から、レグ（時刻・向き）ごとに区間の所要時間と
探索のコスト、区間の表示が読む値を合成する`LegCostComposer`。

入口は`LegCostComposer`（`compose`・`values_at_rows`・`missing_travel_data_share`・`to_full_row_order`・
`lazy_row`）。材料の表は架空の材料で組む。

ここで見ないもの:
- 勾配・風・路面から速度を解く走行モデルそのもの → `test_cycling_speed.py`
- 費目ごとの代償の秒の式 → `test_ledger_costs.py`
- 風を進行方向の成分へ分けることと、予報の格子点の引き当て → `test_wind.py`
- 合成した配列で探索し、経路の区間を組み立てること → `test_route_generation_behavior.py`
"""

import dataclasses
from datetime import datetime, timedelta

import numpy as np
import pytest
from numba.core import event

from app.domain import leg_costs, traffic
from app.domain.attributes import CategoricalColumn
from app.domain.search_materials import SearchMaterials
from app.domain.cost_axes import EFFORT_AXES, CostAxisDefinitions
from app.domain.ledger_costs import LedgerParameters
from app.domain.leg_costs import LegCostArrays, LegCostComposer, LegValues
from app.domain.road_network import MaterialFills
from app.domain.msm import MsmBlock, MsmGrid
from app.domain.road_avoidance import RoadAvoidanceMasks
from app.domain.wind import WindForecastSeries
from tests.cost_axes_fixture import cost_axes
from tests.profile_fixture import grade_profiles, profiles

START = datetime(2026, 10, 3, 9, 0)
CRUISE_KMH = 20.0
AVOID_MULTIPLIER = 3.0
SURFACE = "class:rolling"
STOP_DENSITY = dict(zip(leg_costs.POI_COUNT_KINDS, leg_costs.stop_count_material_ids(), strict=True))
NORTH, SOUTH = 0.0, 180.0
#: 費目の帳簿の式の係数。`effective_strength`は代償の全体に掛ける強さで、0なら費用は所要時間そのもの。
STRENGTH = LedgerParameters(effective_strength=0.5, multipliers={}, effort_alpha=1.0, burden_seconds_per_km=100.0,
                            effort_weight_exponent=0.0)
NO_PENALTY = dataclasses.replace(STRENGTH, effective_strength=0.0)

#: 取込の範囲全体の分布を持たない（欠けた材料は今までどおり0の扱い）。
NO_FILLS = MaterialFills(numeric_means={}, class_shares={})

def _column(values, n: int) -> np.ndarray:
    return np.asarray(values if isinstance(values, (list, tuple, np.ndarray)) else [values] * n, dtype=float)


def _matrix(n: int, *, distance=1000.0, gradient=0.0, bearing=NORTH, surface="paved",
            materials: dict | None = None, categories: dict | None = None, mid_lat=35.0) -> SearchMaterials:
    """`n`区間の材料の表。引数は全区間に同じ値か、区間ごとの並び。停止の密度は`materials`で渡さなければ0。"""
    materials = {**dict.fromkeys(STOP_DENSITY.values(), 0.0), **(materials or {})}
    categories = {SURFACE: [surface] * n if isinstance(surface, str) else surface, **(categories or {})}
    return SearchMaterials(
        distance_m=_column(distance, n), bearing_deg=_column(bearing, n), hard_filtered=np.zeros(n, dtype=bool), road_classes={},
        mid_lat=_column(mid_lat, n), mid_lon=np.full(n, 139.0),
        material_ids=list(materials), material_values=np.stack([_column(v, n) for v in materials.values()]),
        categorical_material_ids=list(categories),
        categorical_material_columns=[CategoricalColumn.encode(v) for v in categories.values()],
        elevation_profiles=grade_profiles(_column(gradient, n), _column(distance, n)),
    )


def _series(speeds_by_hour: list[float], from_deg: float = NORTH) -> WindForecastSeries:
    """格子点1つの、`START`から1時間刻みの予報。"""
    return WindForecastSeries(
        times=[START + timedelta(hours=h) for h in range(len(speeds_by_hour))],
        speed_ms=np.array([speeds_by_hour], dtype=float),
        direction_deg=np.full((1, len(speeds_by_hour)), from_deg),
        lattice=MsmBlock(
            grid=MsmGrid(lat_min=35.0, lon_min=139.0, d_lat=0.05, d_lon=0.0625, n_lat=1, n_lon=1), row0=0, col0=0, rows=1, cols=1,
        ),
    )


#: 無風の予報（格子点1つ・2時刻）。
CALM_SERIES = _series([0.0, 0.0])


def _composer(matrix: SearchMaterials, *, excluded=None, cost_scale=None, series=CALM_SERIES, lazy=None,
              fills=NO_FILLS, axes: CostAxisDefinitions | None = None, parameters=NO_PENALTY) -> LegCostComposer:
    n = len(matrix.distance_m)
    masks = RoadAvoidanceMasks(
        excluded=np.zeros(n, dtype=bool) if excluded is None else np.asarray(excluded, dtype=bool),
        cost_scale=np.ones(n) if cost_scale is None else np.asarray(cost_scale, dtype=float),
    )
    return LegCostComposer(
        matrix, masks, series, START, CRUISE_KMH,
        np.arange(n) if lazy is None else np.asarray(lazy), detour_ratio=1.3, material_fills=fills,
        axes=cost_axes() if axes is None else axes, parameters=parameters,
    )


def _snapshot(matrix, **kwargs):
    return _composer(matrix, **kwargs).compose("leg", 0.0, +1)


def _shown(matrix, **kwargs) -> tuple[LegCostArrays, LegValues]:
    """`_snapshot`のレグと、その全区間の表示の値（区間の表示と同じく、レグのビンの時刻で合成し直したもの）。"""
    composer = _composer(matrix, **kwargs)
    leg = composer.compose("leg", 0.0, +1)
    return leg, composer.values_at_rows(np.arange(len(matrix.distance_m)), leg.bin_times[0])


# --- 所要時間 -------------------------------------------------------------


def test_the_travel_time_runs_the_points_of_the_road_profile_not_its_average_grade():
    """所要時間は行列の区間の断面を点の間ごとに走る。600mで18m登って18m下る道は、平均勾配は平地と同じ0%でも、
    平地より時間がかかる（勾配の材料の平均を読むと同じ時間になる）。"""
    matrix = dataclasses.replace(_matrix(2, distance=600.0), elevation_profiles=profiles([0.0, 18.0, 0.0], [0.0, 0.0, 0.0]))

    up_and_down, flat = _snapshot(matrix).travel_seconds_lazy

    assert up_and_down > flat * 1.1


def test_the_ledger_formula_adds_the_penalty_of_each_road_to_its_travel_time():
    """費用 ＝ 所要時間 ＋ つまみ × 代償（平らな舗装の道は代償0、砂利の道は道のストレスの分だけ高い）。所要時間は強さに
    依らない。"""
    lens = {"thresholds": [1.0], "band_labels": ["a", "b"]}
    presentation = {"label": "x", "description": "", "icon_id": "i", "lens": lens}
    axes = CostAxisDefinitions.model_validate({
        "effort": {axis_id: presentation for axis_id in EFFORT_AXES},
        "burden": {"vibration": {**presentation, "burden": {
            "kind": "categorical", "material": "class:surface_estimate", "per_km": {"paved": 0.0, "gravel": 1.0}}}},
        "total_lens": presentation,
    })
    matrix = _matrix(2, distance=1000.0, categories={"class:surface_estimate": ["paved", "gravel"]})

    leg = _snapshot(matrix, axes=axes, parameters=STRENGTH)
    plain = _snapshot(matrix, axes=axes)

    assert leg.travel_seconds_lazy.tolist() == pytest.approx(plain.travel_seconds_lazy.tolist())
    assert (leg.cost_lazy - leg.travel_seconds_lazy).tolist() == pytest.approx([0.0, 0.5 * 100.0 * 1.0 * 1.0])


def test_a_segment_without_a_stop_count_waits_the_mean_of_the_whole_network():
    """停止要因の数の無い区間は、取込の範囲全体の平均の密度で待つ（0とみなすと、数の無い道が止まらない速い道に見える）。"""
    fills = MaterialFills(numeric_means={STOP_DENSITY["signal"]: 2.0}, class_shares={})
    leg = _snapshot(_matrix(3, distance=500.0, materials={STOP_DENSITY["signal"]: [2.0, np.nan, 0.0]}), fills=fills)

    assert leg.travel_seconds_lazy[1] == pytest.approx(leg.travel_seconds_lazy[0])
    assert leg.travel_seconds_lazy[1] > leg.travel_seconds_lazy[2]


def test_each_stop_on_a_segment_adds_its_share_of_the_wait():
    """2回/kmの信号がある500mの区間は、信号1回ぶん、止まる割合 × 止まったときの待ちを足す。密度の値が無い区間は待たない。"""
    leg = _snapshot(_matrix(3, distance=500.0, materials={STOP_DENSITY["signal"]: [2.0, 0.0, np.nan]}))

    assert leg.travel_seconds_lazy[0] - leg.travel_seconds_lazy[1] == pytest.approx(
        traffic.stop_event("stop", "signal").expected_seconds)
    assert leg.travel_seconds_lazy[2] == leg.travel_seconds_lazy[1]


def test_a_matrix_without_a_column_the_travel_time_reads_is_refused():
    """所要時間が読む材料の列が無い行列を通すと、その材料が足す時間（停止の待ち等）が全区間で黙って0秒になる。"""
    matrix = _matrix(2)
    kept = [i for i, material_id in enumerate(matrix.material_ids) if material_id != STOP_DENSITY["signal"]]

    with pytest.raises(ValueError, match=STOP_DENSITY["signal"]):
        dataclasses.replace(
            matrix, material_ids=[matrix.material_ids[i] for i in kept], material_values=matrix.material_values[kept],
        )


def test_an_excluded_segment_cannot_be_passed():
    leg = _snapshot(_matrix(2), parameters=STRENGTH, excluded=[True, False])

    assert np.isinf(leg.travel_seconds_lazy[0]) and np.isinf(leg.cost_lazy[0])
    assert np.isfinite(leg.cost_lazy[1])


def test_a_segment_to_avoid_costs_more_and_one_to_prefer_costs_less_but_both_take_the_same_time():
    """好む道は避ける道の倍率の逆数で費用が下がる。倍率が所要時間へ混ざると、避けた道・好む道を通った候補の所要時間と到着の
    予想が延び縮みする。"""
    leg = _snapshot(_matrix(3), cost_scale=[AVOID_MULTIPLIER, 1.0, 1.0 / AVOID_MULTIPLIER])

    assert leg.cost_lazy[0] == pytest.approx(AVOID_MULTIPLIER * leg.cost_lazy[1])
    assert leg.cost_lazy[2] == pytest.approx(leg.cost_lazy[1] / AVOID_MULTIPLIER)
    assert leg.travel_seconds_lazy.tolist() == pytest.approx([leg.travel_seconds_lazy[1]] * 3)


# --- 探索の行順 ---------------------------------------------------------------


def test_the_search_order_holds_only_the_segments_on_the_search_graph():
    """同じ2点を結ぶ区間が2本あると、探索のグラフには1本しか載らない（載らない区間は-1・NaN）。"""
    matrix = _matrix(3, distance=[1000.0, 2000.0, 3000.0])
    composer = _composer(matrix, lazy=[2, 0])
    full = _snapshot(matrix).travel_seconds_lazy

    leg = composer.compose("leg", 0.0, +1)

    assert leg.travel_seconds_lazy.tolist() == full[[2, 0]].tolist()
    assert [composer.lazy_row(row) for row in range(3)] == [1, -1, 0]
    restored = composer.to_full_row_order(leg.travel_seconds_lazy)
    assert restored[[0, 2]].tolist() == full[[0, 2]].tolist()
    assert np.isnan(restored[1])


# --- 時刻ビン -----------------------------------------------------------------

@pytest.mark.parametrize(
    ("offset", "direction", "duration_hours", "bin_starts"),
    [
        (1.0, +1, None, (1.0,)),  # 見込み時間が無ければ、レグ全体を開始時刻で1本
        (1.0, +1, 0.0, (1.0,)),
        (1.0, +1, 2.5, (1.0, 2.0, 3.0)),
        (1.0, +1, 10.0, tuple(1.0 + k for k in range(leg_costs.MAX_TIME_BINS))),  # 上限で打ち切る
        (5.0, -1, 2.0, (3.0, 4.0)),  # 起点へ向かうレグは、その時刻で終わる
    ],
)
def test_a_leg_is_cut_into_hourly_bins_over_its_expected_duration(offset, direction, duration_hours, bin_starts):
    composer = _composer(_matrix(1), series=_series([0.0] * 12))

    leg = composer.compose("leg", offset, direction, duration_hours=duration_hours)

    assert leg.bin_times == tuple(composer.bin_time(start) for start in bin_starts)
    assert len(leg.cost_bins_lazy) == len(leg.travel_bins_lazy) == len(bin_starts)
    assert leg.bin_seconds == (np.inf if len(bin_starts) == 1 else leg_costs.TIME_BIN_HOURS * 3600.0)


def test_legs_with_the_same_bins_but_a_different_middle_are_not_mixed_up():
    """同じ開始時刻・同じ本数でも、見込み時間が違えば代表のビンは変わる。"""
    composer = _composer(_matrix(1), series=_series([float(h) for h in range(12)]))

    shorter = composer.compose("a", 0.0, +1, duration_hours=4.0)
    longer = composer.compose("b", 0.0, +1, duration_hours=7.0)

    assert shorter.cost_lazy.tolist() == shorter.cost_bins_lazy[2].tolist()
    assert longer.cost_lazy.tolist() == longer.cost_bins_lazy[3].tolist()


@pytest.mark.parametrize(
    "speeds_by_hour",
    [
        [float(h) for h in range(12)],  # 予報の時刻ごとに風が変わる（終盤は予報の端へ寄せる）
        [6.0, 6.0],  # どのビンも予報の端の時刻を引く
    ],
)
def test_a_leg_sharing_hours_with_an_earlier_leg_gets_the_bins_of_its_own_hours(speeds_by_hour):
    """レグのどのビンも、その時刻だけを新しく合成したものと同じ（取り違えると、別の時刻の風で探す）。
    前のレグと時刻が重なっても同じ。"""
    def composer() -> LegCostComposer:
        return _composer(_matrix(1), parameters=STRENGTH, series=_series(speeds_by_hour))
    shared = composer()
    shared.compose("outbound", 7.5, +1, duration_hours=3.0)

    later = shared.compose("inbound", 9.5, +1, duration_hours=4.0)
    starts = [9.5 + k * leg_costs.TIME_BIN_HOURS for k in range(len(later.bin_times))]
    alone = [composer().compose("bin", start, +1) for start in starts]

    assert later.cost_bins_lazy.tolist() == [leg.cost_lazy.tolist() for leg in alone]
    assert later.travel_bins_lazy.tolist() == [leg.travel_seconds_lazy.tolist() for leg in alone]


def test_a_tree_without_a_clock_reads_the_wind_at_each_segment_s_own_passage():
    """目的地から遡る木は時刻ビンを使えず、区間ごとの通過時刻で1本に合成する。"""
    composer = _composer(_matrix(2), series=_series([0.0, 8.0]))
    passage = np.array([0.0, 1.0])

    leg = composer.compose("inbound", 3.0, -1, passage_hours=passage)

    assert leg.travel_seconds_lazy[1] > leg.travel_seconds_lazy[0]
    assert len(leg.cost_bins_lazy) == len(leg.bin_times) == 1


def test_trees_without_a_clock_that_pass_at_different_hours_are_not_mixed_up():
    """同じ時刻・向きのレグでも、区間ごとの通過時刻が違えば前の合成を使い回さない（使い回すと別の時刻の風で探す）。
    通過時刻の和が同じで並びだけ違う2本でも同じ。"""
    composer = _composer(_matrix(2), series=_series([0.0, 8.0]))

    first = composer.compose("inbound", 3.0, -1, passage_hours=np.array([0.0, 1.0]))
    second = composer.compose("inbound", 3.0, -1, passage_hours=np.array([1.0, 0.0]))

    assert second.travel_seconds_lazy[0] > first.travel_seconds_lazy[0]


def test_values_recomposed_for_the_rows_on_the_route_match_the_composition_used_by_the_search():
    """表示は経路上の行だけをその時刻で合成し直す。全区間で合成した値の同じ行と同じで、探索の費用は所要時間と代償の秒の
    和になる（探索コストと表示の一致）。"""
    matrix = _matrix(3, bearing=[NORTH, SOUTH, 90.0], gradient=[0.0, 3.0, -2.0])
    composer = _composer(matrix, parameters=STRENGTH, series=_series([0.0, 6.0]))
    leg = composer.compose("leg", 1.0, +1)

    values = composer.values_at_rows(np.array([2, 0]), leg.bin_times[0])
    whole = composer.values_at_rows(np.arange(3), leg.bin_times[0])

    penalty = sum(values.penalty_by_axis.values(), np.zeros(2))
    assert leg.cost_lazy[[2, 0]] == pytest.approx(leg.travel_seconds_lazy[[2, 0]] + penalty, rel=1e-6)
    assert {a: v.tolist() for a, v in values.penalty_by_axis.items()} == {
        a: v[[2, 0]].tolist() for a, v in whole.penalty_by_axis.items()}
    assert values.headwind_ms.tolist() == whole.headwind_ms[[2, 0]].tolist()


# --- 所要時間の欠け ---------------------------------------------------


def test_the_share_of_distance_timed_without_gradient_or_stop_data():
    composer = _composer(_matrix(
        3, distance=[1000.0, 3000.0, 6000.0], gradient=[np.nan, 0.0, 0.0],
        materials={STOP_DENSITY["signal"]: [0.0, np.nan, 0.0]},
    ))

    assert composer.missing_travel_data_share(np.array([0, 1, 2])) == 0.4
    assert composer.missing_travel_data_share(np.array([], dtype=np.int64)) is None


# --- JITの型 -------------------------------------------------------------------


def test_composing_compiles_nothing_after_baking_whatever_arrays_the_matrix_holds():
    """イメージの組み立てで焼いたコンパイル結果（`compile_leg_cost_kernels`）は、型の同じ呼び出しにしか効かない。
    合成が費用の組み立てのJITへ渡す配列の型を揃えるため、行列の列のdtype・読み取り専用かに依らず、焼いた後の合成は
    コンパイルしない——本番の最初のルート生成がコンパイルを払わない（道路網の列は読み取り専用で読まれる）。
    コンパイルはnumbaの出来事で数える。"""
    leg_costs.compile_leg_cost_kernels()
    matrix = _matrix(3)
    distance = np.full(3, 1000.0)
    distance.flags.writeable = False
    matrices = [matrix, dataclasses.replace(matrix, distance_m=distance)]

    with event.install_recorder("numba:compile") as compiled:
        for each in matrices:
            _composer(each, parameters=STRENGTH, cost_scale=[AVOID_MULTIPLIER, 1.0, 1.0],
                      series=_series([0.0, 3.0])).compose("leg", 0.0, +1, duration_hours=2.0)

    assert compiled.buffer == []
