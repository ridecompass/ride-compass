"""`domain/leg_costs.py`——探索範囲の静的スコア行列・重み・0次フィルタ・風・昼夜から、レグ（時刻・向き）ごとに区間の所要時間と
探索のコスト、区間の表示が読む値を合成する`LegCostComposer`。

入口は`LegCostComposer`（`compose`・`values_at_rows`・`winds_at`・`missing_travel_data_share`・`to_full_row_order`・
`lazy_row`・`wind_unavailable`）と、`LegCostArrays`/`RowValues`の`axis_contributions_at`、`material_value_at`。
静的スコア行列は架空の軸・材料で組み、風に依る軸と夜だけ効く軸は軸の宣言（本番はDBが正本）を架空の1本へ差し替える。

ここで見ないもの:
- 勾配・風・路面から速度を解く走行モデルそのもの → `test_cycling_speed.py`
- 軸の得点の重み付き平均と、データの無い区間の扱い → `test_difficulty.py`・`test_axis_definitions.py`
- 風を進行方向の成分へ分けることと、予報の格子点の引き当て → `test_wind.py`
- ある時刻が夜か（市民薄明の外か） → `test_twilight.py`
- 合成した配列で探索し、経路の区間を組み立てること → `test_route_generation_behavior.py`
"""

import dataclasses
from datetime import datetime, timedelta

import numpy as np
import pytest

from app.domain import leg_costs
from app.domain.attributes import CategoricalColumn
from app.domain.axis_definitions import BreakpointLinearShape, MaterialTerm
from app.domain.cycling_speed import RiderProfile, SegmentSpeedModel, crr_for_surface
from app.domain.evaluation import DensityAxisColumn, StaticEdgeScoreMatrix
from app.domain.leg_costs import LegCostComposer
from app.domain.road_avoidance import RoadAvoidanceMasks
from app.domain.route import Coordinates
from app.domain.msm import MsmBlock, MsmGrid
from app.domain.wind import DepartureWind, WindForecastSeries
from tests.axis_system_fixture import axis_definition, replaced_axis_definitions

START = datetime(2026, 10, 3, 9, 0)
CRUISE_KMH = 20.0
AVOID_MULTIPLIER = 3.0
SURFACE = "class:rolling"
GRADIENT = leg_costs.GRADIENT_PERCENT
WIND_DRAG = next(iter(leg_costs.REQUEST_DYNAMIC_MATERIAL_IDS))
STOP_DENSITY = dict(zip(leg_costs.POI_COUNT_KINDS, leg_costs.stop_count_material_ids(), strict=True))
WIND_AXIS = "axis_wind"
NIGHT_AXIS = "axis_night"
STOP_AXIS = "axis_stops"
#: 信号の1kmあたりの回数を、0から始まる直線（11回/kmで100点、その先は100点）で点数にする（停止密度の軸の形）。
STOP_LINE = BreakpointLinearShape(terms=[MaterialTerm(material=STOP_DENSITY["signal"])], breakpoints=[(0.0, 0.0), (11.0, 100.0)])
NORTH, SOUTH = 0.0, 180.0
#: 昼夜を決める地点。`START`の日の市民薄明の終わりは17時51分、翌朝の始まりは5時15分（JST）。
PLACE = Coordinates(latitude=35.0, longitude=139.0)


@pytest.fixture
def wind_axis():
    """風の追加負荷（0で0点・1で100点）を読む公開軸。"""
    with replaced_axis_definitions({WIND_AXIS: axis_definition(WIND_AXIS, material=WIND_DRAG, is_published=True)}):
        yield


def _column(values, n: int) -> np.ndarray:
    return np.asarray(values if isinstance(values, (list, tuple, np.ndarray)) else [values] * n, dtype=float)


def _matrix(n: int, *, distance=1000.0, gradient=0.0, bearing=NORTH, surface="paved",
            axes: dict | None = None, raw_axes: dict | None = None, materials: dict | None = None,
            categories: dict | None = None, signals_per_km=None, mid_lat=35.0) -> StaticEdgeScoreMatrix:
    """`n`区間の静的スコア行列。引数は全区間に同じ値か、区間ごとの並び。停止の密度は`materials`で渡さなければ0。

    `signals_per_km`を渡すと、その信号の密度で待ちが入り、密度の軸`STOP_AXIS`（折れ線は`STOP_LINE`）が点数を持つ。"""
    axes, raw_axes = dict(axes or {}), raw_axes or {}
    materials = {GRADIENT: gradient, **dict.fromkeys(STOP_DENSITY.values(), 0.0), **(materials or {})}
    density_axes = {}
    if signals_per_km is not None:
        signals = _column(signals_per_km, n)
        materials[STOP_DENSITY["signal"]] = signals
        axes[STOP_AXIS] = STOP_LINE.scores_at(signals.tolist())
        density_axes[STOP_AXIS] = DensityAxisColumn(shape=STOP_LINE, inputs=signals)
    categories = {SURFACE: [surface] * n if isinstance(surface, str) else surface, **(categories or {})}

    def stacked(columns: dict) -> np.ndarray:
        return np.stack([_column(v, n) for v in columns.values()], axis=1) if columns else np.empty((n, 0))

    return StaticEdgeScoreMatrix(
        axis_ids=list(axes), axis_scores=stacked(axes),
        distance_m=_column(distance, n), bearing_deg=_column(bearing, n), hard_filtered=np.zeros(n, dtype=bool), road_classes={},
        mid_lat=_column(mid_lat, n), mid_lon=np.full(n, 139.0),
        raw_axis_ids=list(raw_axes), axis_raw_values=stacked(raw_axes),
        material_ids=list(materials), material_values=stacked(materials),
        categorical_material_ids=list(categories),
        categorical_material_columns=[CategoricalColumn.encode(v) for v in categories.values()],
        density_axes=density_axes,
    )


def _departure_wind(speed_ms: float, from_deg: float = NORTH) -> DepartureWind:
    return DepartureWind(speed_ms=speed_ms, direction_deg=from_deg)


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


def _composer(matrix: StaticEdgeScoreMatrix, *, weights=None, penalty=0.0, excluded=None, avoided=None,
              departure_wind=None, series=None, lazy=None) -> LegCostComposer:
    n = len(matrix.distance_m)
    none = np.zeros(n, dtype=bool)
    masks = RoadAvoidanceMasks(
        excluded=none if excluded is None else np.asarray(excluded, dtype=bool),
        avoided=none if avoided is None else np.asarray(avoided, dtype=bool),
    )
    return LegCostComposer(
        matrix, weights or {}, penalty, masks, AVOID_MULTIPLIER,
        departure_wind, series, START, CRUISE_KMH,
        np.arange(n) if lazy is None else np.asarray(lazy), detour_ratio=1.3, twilight_origin=PLACE,
    )


def _snapshot(matrix, **kwargs):
    return _composer(matrix, **kwargs).compose("leg", None, 0.0, +1)


# --- 所要時間 -------------------------------------------------------------


def test_the_gradient_in_percent_slows_the_rider_as_that_grade_and_a_missing_one_counts_as_flat():
    """勾配の材料は%で、走行モデルは割合で読む。読み違えると、坂の所要時間が別の勾配の坂のものになる。"""
    leg = _snapshot(_matrix(3, gradient=[5.0, np.nan, 0.0]))
    climb, missing, flat = leg.travel_seconds_full
    five_percent = SegmentSpeedModel(
        RiderProfile(cruise_speed_kmh=CRUISE_KMH), np.array([0.05]), crr_for_surface(CategoricalColumn.encode(["paved"])))

    assert climb == pytest.approx(five_percent.travel_seconds(np.array([1000.0]), np.zeros(1), np.zeros(1))[0])
    assert missing == flat


def test_each_stop_on_a_segment_adds_its_wait():
    """2回/kmの信号がある500mの区間は、信号1回ぶん待つ。密度の値が無い区間は待たない。"""
    leg = _snapshot(_matrix(3, distance=500.0, materials={STOP_DENSITY["signal"]: [2.0, 0.0, np.nan]}))

    assert leg.travel_seconds_full[0] - leg.travel_seconds_full[1] == pytest.approx(leg_costs.stop_seconds("signal"))
    assert leg.travel_seconds_full[2] == leg.travel_seconds_full[1]


def test_a_matrix_without_a_column_the_travel_time_reads_is_refused():
    """所要時間が読む材料の列が無い行列を通すと、その材料が足す時間（停止の待ち等）が全区間で黙って0秒になる。"""
    matrix = _matrix(2)
    kept = [i for i, material_id in enumerate(matrix.material_ids) if material_id != STOP_DENSITY["signal"]]

    with pytest.raises(ValueError, match=STOP_DENSITY["signal"]):
        dataclasses.replace(
            matrix, material_ids=[matrix.material_ids[i] for i in kept], material_values=matrix.material_values[:, kept],
        )


def test_an_excluded_segment_cannot_be_passed():
    leg = _snapshot(_matrix(2, axes={"axis_a": 10.0}), weights={"axis_a": 1.0}, penalty=0.5, excluded=[True, False])

    assert np.isinf(leg.travel_seconds_full[0]) and np.isinf(leg.cost_lazy[0])
    assert np.isfinite(leg.cost_lazy[1])


def test_a_segment_to_avoid_costs_more_but_takes_the_same_time():
    """割り増しが所要時間へ混ざると、避けた道を通った候補の所要時間と到着の予想が延びる。"""
    leg = _snapshot(_matrix(2), avoided=[True, False])

    assert leg.cost_lazy[0] == pytest.approx(AVOID_MULTIPLIER * leg.cost_lazy[1])
    assert leg.travel_seconds_full[0] == pytest.approx(leg.travel_seconds_full[1])


@pytest.mark.parametrize(
    ("departure_wind", "series", "unavailable"),
    [(None, None, True), (_departure_wind(0.0), None, False), (None, _series([0.0, 0.0]), False)],
)
def test_the_travel_time_is_marked_when_no_wind_was_available(departure_wind, series, unavailable):
    assert _composer(_matrix(1), departure_wind=departure_wind, series=series).wind_unavailable is unavailable


# --- コストと表示の値 ---------------------------------------------------------


def test_without_weights_the_cost_is_the_travel_time():
    """好みの重みをすべて0にすると素の所要時間になり、最速の基準線と同じ物差しになる。重みの表に無い密度の軸も何も足さない。"""
    matrix = _matrix(2, axes={"axis_a": [100.0, 0.0]}, signals_per_km=[2.0, 0.0])

    leg = _snapshot(matrix, weights={"axis_a": 0.0}, penalty=0.7)

    assert leg.cost_lazy.tolist() == leg.travel_seconds_lazy.tolist()


@pytest.mark.parametrize(("wind_weight", "difficulty"), [(0.0, 65.0), (1.0, 52.0)])
def test_the_cost_is_the_travel_time_raised_by_the_weighted_difficulty(wind_axis, wind_weight, difficulty):
    """コスト＝所要時間×(1＋換算レート×difficulty/100)。風に依る軸に重みがあるときも無いときも同じ式で合成する。

    得点は区間ごとに軸a=20（重み1）・軸b=80（重み3）、風の軸は無風で0点。
    """
    matrix = _matrix(2, axes={"axis_a": 20.0, "axis_b": 80.0, WIND_AXIS: np.nan})
    weights = {"axis_a": 1.0, "axis_b": 3.0, WIND_AXIS: wind_weight}

    leg = _composer(matrix, weights=weights, penalty=0.5, series=_series([0.0, 0.0])).compose("leg", None, 0.0, +1)

    assert leg.difficulty_array.tolist() == [difficulty, difficulty]
    assert leg.cost_lazy == pytest.approx(leg.travel_seconds_lazy * (1 + 0.5 * difficulty / 100))


@pytest.mark.parametrize(
    ("matrix", "axis"),
    [(_matrix(2, axes={"axis_a": [40.0, np.nan]}), "axis_a"), (_matrix(2, signals_per_km=[2.0, np.nan]), STOP_AXIS)],
    ids=["点数の軸", "密度の軸"],
)
def test_a_segment_without_data_on_the_weighted_axes_is_raised_by_the_mean_difficulty_around_it(matrix, axis):
    """重みのある軸がどれも欠損の区間は、探索の範囲の距離平均のdifficultyで割増す（割増なしだとデータの無い道ほど
    安く見えて選ばれる）。表示のdifficultyは欠損のまま。密度の軸も、回数の無い区間は足す秒を持たずに割増だけを受ける。"""
    leg = _snapshot(matrix, weights={axis: 1.0}, penalty=0.5)

    assert np.isnan(leg.difficulty_array[1])
    assert leg.cost_lazy[1] == pytest.approx(leg.travel_seconds_lazy[1] * (1 + 0.5 * leg.difficulty_array[0] / 100))


def test_a_density_axis_adds_seconds_in_proportion_to_the_count_and_its_share_of_the_weights():
    """1kmに信号2回の区間。停止密度の軸（傾き 100/11 点/(回/km)）と軸a（30点）に同じ重みを置くと、費用は
    所要時間 × (1 + P × 軸aの分15点/100) に、P × 重みの割合1/2 × 傾き/100 × 2回 × 想定速度で1km走る秒 を足したもの。
    停止の待ちの秒は所要時間に入っていて、密度の軸の点数では割増さない。重みは割合だけが効き、和が1以下でも同じ。"""
    leg = _snapshot(_matrix(1, signals_per_km=2.0, axes={"axis_a": 30.0}),
                    weights={STOP_AXIS: 0.25, "axis_a": 0.25}, penalty=0.7)

    cruise_seconds_per_km = 3600.0 / CRUISE_KMH
    added = 0.7 * 0.5 * (100.0 / 11.0) / 100 * 2.0 * cruise_seconds_per_km
    assert leg.cost_lazy[0] == pytest.approx(leg.travel_seconds_lazy[0] * (1 + 0.7 * 15.0 / 100) + added)


@pytest.mark.parametrize("hourly", [False, True], ids=["時刻で変わらない合成", "時刻のビンごとの合成"])
def test_a_density_axis_costs_the_same_along_a_route_however_its_road_is_cut(wind_axis, hourly):
    """信号1つのある100mの区間と、それを信号の所で10mと90mに切った2区間（端の信号は両側が0.5回ずつ持つ）は、密度の
    軸の費用の和が同じ。区間の点数で割増すと、回数の集まる10mの区間が頭打ちの点数になり、待ちの秒にも割増が掛かって、
    切り方で探索の選ぶ道が変わる。ほかの軸（30点）の割増と、風の軸に重みを置いた時刻ごとの合成でも同じ。"""
    weights = {STOP_AXIS: 1.0, "axis_a": 1.0, WIND_AXIS: 1.0 if hourly else 0.0}
    kwargs = {"weights": weights, "penalty": 0.7, "series": _series([0.0, 0.0]) if hourly else None}
    whole = _matrix(2, distance=[100.0, 400.0], signals_per_km=[10.0, 0.0], axes={"axis_a": 30.0, WIND_AXIS: np.nan})
    cut = _matrix(3, distance=[10.0, 90.0, 400.0], signals_per_km=[50.0, 0.5 / 0.09, 0.0],
                  axes={"axis_a": 30.0, WIND_AXIS: np.nan})

    whole_leg = _composer(whole, **kwargs).compose("leg", None, 0.0, +1)
    cut_leg = _composer(cut, **kwargs).compose("leg", None, 0.0, +1)

    assert cut_leg.cost_lazy.sum() == pytest.approx(whole_leg.cost_lazy.sum(), rel=1e-9)
    assert whole_leg.cost_lazy.sum() > whole_leg.travel_seconds_lazy.sum()


def test_an_axis_that_reads_the_wind_scores_a_headwind_above_a_tailwind(wind_axis):
    matrix = _matrix(2, bearing=[NORTH, SOUTH], axes={WIND_AXIS: np.nan})

    leg = _snapshot(matrix, weights={WIND_AXIS: 1.0}, departure_wind=_departure_wind(5.0, from_deg=NORTH))

    assert leg.axis_arrays[WIND_AXIS][0] > leg.axis_arrays[WIND_AXIS][1]
    assert leg_costs.material_value_at(leg, WIND_DRAG, 0) > 0 > leg_costs.material_value_at(leg, WIND_DRAG, 1)


def test_without_any_wind_the_wind_has_no_value_on_a_segment(wind_axis):
    leg = _snapshot(_matrix(1, axes={WIND_AXIS: np.nan}), weights={WIND_AXIS: 1.0})

    assert WIND_DRAG not in leg.material_arrays
    assert np.isnan(leg.axis_arrays[WIND_AXIS][0])


def test_the_values_shown_on_a_segment_are_the_columns_of_their_own_ids():
    leg = _snapshot(_matrix(
        2,
        raw_axes={"axis_a": [1.0, 2.0], "axis_b": [3.0, 4.0]},
        materials={"material_a": [5.0, np.nan], "material_b": [7.0, 8.0]},
        categories={"category_a": ["x", "y"]},
    ))

    assert leg.axis_raw_arrays["axis_b"].tolist() == [3.0, 4.0]
    assert leg.material_arrays["material_b"].tolist() == [7.0, 8.0]
    assert leg.categorical_material_arrays["category_a"].value_at(1) == "y"
    assert leg_costs.material_value_at(leg, "material_a", 0) == 5.0
    # 欠損と、合成に無い材料は値を持たない。
    assert leg_costs.material_value_at(leg, "material_a", 1) is None
    assert leg_costs.material_value_at(leg, "material_z", 0) is None


# --- 探索の行順 ---------------------------------------------------------------


def test_the_search_order_holds_only_the_segments_on_the_search_graph():
    """同じ2点を結ぶ区間が2本あると、探索のグラフには1本しか載らない（載らない区間は-1・NaN）。"""
    composer = _composer(_matrix(3, distance=[1000.0, 2000.0, 3000.0]), lazy=[2, 0])

    leg = composer.compose("leg", None, 0.0, +1)

    assert leg.travel_seconds_lazy.tolist() == leg.travel_seconds_full[[2, 0]].tolist()
    assert [composer.lazy_row(row) for row in range(3)] == [1, -1, 0]
    restored = composer.to_full_row_order(leg.travel_seconds_lazy)
    assert restored[[0, 2]].tolist() == leg.travel_seconds_full[[0, 2]].tolist()
    assert np.isnan(restored[1])


# --- 時刻ビン -----------------------------------------------------------------


def test_without_an_hourly_forecast_every_leg_shares_one_composition():
    composer = _composer(_matrix(1), departure_wind=_departure_wind(3.0))

    outbound = composer.compose("outbound", None, 0.0, +1, duration_hours=3.0)
    inbound = composer.compose("inbound", None, 2.0, -1, duration_hours=3.0)

    assert inbound is outbound
    assert (len(outbound.cost_bins_lazy), outbound.bin_seconds, outbound.bin_start_hours) == (1, np.inf, ())


@pytest.mark.parametrize(
    ("duration_hours", "bin_starts"),
    [
        (None, (1.0,)),  # 見込み時間が無ければ、レグ全体を開始時刻で1本
        (0.0, (1.0,)),
        (2.5, (1.0, 2.0, 3.0)),
        (10.0, tuple(1.0 + k for k in range(leg_costs.MAX_TIME_BINS))),  # 上限で打ち切る
    ],
)
def test_a_leg_is_cut_into_hourly_bins_over_its_expected_duration(duration_hours, bin_starts):
    leg = _composer(_matrix(1), series=_series([0.0] * 12)).compose("leg", None, 1.0, +1, duration_hours=duration_hours)

    assert leg.bin_start_hours == bin_starts
    assert len(leg.cost_bins_lazy) == len(leg.travel_bins_lazy) == len(bin_starts)
    assert leg.bin_seconds == (np.inf if len(bin_starts) == 1 else leg_costs.TIME_BIN_HOURS * 3600.0)


def test_a_leg_toward_the_anchor_ends_at_its_offset():
    leg = _composer(_matrix(1), series=_series([0.0] * 12)).compose("leg", None, 5.0, -1, duration_hours=2.0)

    assert leg.bin_start_hours == (3.0, 4.0)


def test_legs_with_the_same_bins_but_a_different_middle_are_not_mixed_up():
    """同じ開始時刻・同じ本数でも、見込み時間が違えば代表のビンは変わる。"""
    composer = _composer(_matrix(1), series=_series([float(h) for h in range(12)]))

    shorter = composer.compose("a", None, 0.0, +1, duration_hours=4.0)
    longer = composer.compose("b", None, 0.0, +1, duration_hours=7.0)

    assert shorter.cost_lazy.tolist() == shorter.cost_bins_lazy[2].tolist()
    assert longer.cost_lazy.tolist() == longer.cost_bins_lazy[3].tolist()


def test_a_tree_without_a_clock_reads_the_wind_at_each_segment_s_own_passage():
    """目的地から遡る木は時刻ビンを使えず、区間ごとの通過時刻で1本に合成する。"""
    composer = _composer(_matrix(2), series=_series([0.0, 8.0]))
    passage = np.array([0.0, 1.0])

    leg = composer.compose("inbound", None, 3.0, -1, passage_hours=passage)

    assert leg.travel_seconds_full[1] > leg.travel_seconds_full[0]
    assert (len(leg.cost_bins_lazy), leg.bin_start_hours) == (1, ())
    assert leg.passage_hours is passage


def test_trees_without_a_clock_that_pass_at_different_hours_are_not_mixed_up():
    """同じ時刻・向きのレグでも、通過時刻が違えば前の合成を使い回さない（使い回すと別の時刻の風で探す）。"""
    composer = _composer(_matrix(1), series=_series([0.0, 8.0]))

    calm = composer.compose("inbound", None, 3.0, -1, passage_hours=np.array([0.0]))
    windy = composer.compose("inbound", None, 3.0, -1, passage_hours=np.array([1.0]))

    assert windy.travel_seconds_full[0] > calm.travel_seconds_full[0]


@pytest.mark.parametrize("wind_weight", [0.0, 1.0])
def test_values_recomposed_for_the_rows_on_the_route_match_the_composition_used_by_the_search(wind_axis, wind_weight):
    """表示は経路上の行だけをその時刻で合成し直す。探索が使った合成と同じ値になる（探索コストと表示の一致）。"""
    matrix = _matrix(
        3, bearing=[NORTH, SOUTH, 90.0], axes={"axis_a": [10.0, 50.0, 90.0], WIND_AXIS: np.nan},
        materials={"material_a": [1.0, 2.0, 3.0]},
    )
    weights = {"axis_a": 1.0, WIND_AXIS: wind_weight}
    composer = _composer(matrix, weights=weights, penalty=0.5, series=_series([0.0, 6.0]))
    leg = composer.compose("leg", None, 0.0, +1, passage_hours=np.full(3, 1.0))

    values = composer.values_at_rows(np.array([2, 0]), np.array([1.0, 1.0]))

    assert values.difficulty_array.tolist() == leg.difficulty_array[[2, 0]].tolist()
    assert values.weight_sums.tolist() == leg.weight_sums[[2, 0]].tolist()
    assert {a: v.tolist() for a, v in values.axis_arrays.items()} == {
        a: v[[2, 0]].tolist() for a, v in leg.axis_arrays.items()}
    assert {m: v.tolist() for m, v in values.material_arrays.items()} == {
        m: v[[2, 0]].tolist() for m, v in leg.material_arrays.items()}
    assert values.axis_contributions_at(0) == leg.axis_contributions_at(2)


# --- 昼夜 -----------------------------------------------------------------------


@pytest.fixture
def night_axis():
    """夜だけ重みが効く公開軸。"""
    definition = axis_definition(NIGHT_AXIS, is_published=True, time_scope="night_only")
    with replaced_axis_definitions({NIGHT_AXIS: definition}):
        yield


def _night_composer(n: int = 1) -> LegCostComposer:
    """0点の常に効く軸と100点の夜の軸に同じ重みがあり、夜に通る区間は合成が50点で、所要時間の1.25倍の
    コストになる。風の時別予報は無い。"""
    return _composer(
        _matrix(n, axes={"axis_a": 0.0, NIGHT_AXIS: 100.0}), weights={"axis_a": 1.0, NIGHT_AXIS: 1.0}, penalty=0.5,
    )


def test_the_night_axis_weighs_only_in_the_bins_ridden_in_the_dark(night_axis):
    """16時30分・17時30分・18時30分に始まるビンのうち、日没の後の最後だけに効く。"""
    leg = _night_composer().compose("leg", None, 7.5, +1, duration_hours=3.0)

    ratio = leg.cost_bins_lazy[:, 0] / leg.travel_bins_lazy[:, 0]
    assert ratio.tolist() == pytest.approx([1.0, 1.0, 1.25])


def test_the_display_of_a_segment_weighs_the_night_axis_at_the_hour_it_is_ridden(night_axis):
    """17時30分に通る区間には夜の軸が効かず、18時30分に通る区間には効く。"""
    values = _night_composer().values_at_rows(np.array([0, 0]), np.array([8.5, 9.5]))

    assert values.difficulty_array.tolist() == [0.0, 50.0]
    assert [values.axis_contributions_at(i) for i in (0, 1)] == [
        {"axis_a": 0.0, NIGHT_AXIS: 0.0}, {"axis_a": 0.0, NIGHT_AXIS: 50.0}]


# --- 所要時間の欠け・区間の風 ---------------------------------------------------


def test_the_share_of_distance_timed_without_gradient_or_stop_data():
    composer = _composer(_matrix(
        3, distance=[1000.0, 3000.0, 6000.0], gradient=[np.nan, 0.0, 0.0],
        materials={STOP_DENSITY["signal"]: [0.0, np.nan, 0.0]},
    ))

    assert composer.missing_travel_data_share(np.array([0, 1, 2])) == 0.4
    assert composer.missing_travel_data_share(np.array([], dtype=np.int64)) is None


def test_the_wind_of_a_segment_is_the_forecast_at_its_passage():
    composer = _composer(_matrix(4), series=_series([1.04, 2.0, 3.0], from_deg=90.0))

    winds = composer.winds_at([0, 1, 2, 3], [0.2, 1.0, 1.0, 9.0], [False, False, True, False])

    # 時刻ビンの範囲の先・計算値の期間の先は、最後に追った値を延ばして評価しているので、値を出さない。
    assert winds == [
        leg_costs.SegmentWind(speed_ms=1.0, direction_deg=90.0, forecast_at="2026-10-03T09:00"),
        leg_costs.SegmentWind(speed_ms=2.0, direction_deg=90.0, forecast_at="2026-10-03T10:00"),
        None,
        None,
    ]


def test_a_segment_whose_nearest_grid_point_is_outside_the_forecast_shows_no_wind():
    """予報の格子点の並びの外の区間は端の格子点の風で評価しているので、最寄りの格子点の値として示さない。"""
    composer = _composer(_matrix(2, mid_lat=[35.0, 35.5]), series=_series([1.0, 2.0]))

    winds = composer.winds_at([0, 1], [0.0, 0.0], [False, False])

    assert winds[0] is not None
    assert winds[1] is None


def test_a_segment_evaluated_with_the_wind_at_departure_shows_no_wind():
    composer = _composer(_matrix(2), departure_wind=_departure_wind(3.0, from_deg=271.1))

    winds = composer.winds_at([0, 1], [None, 0.5], [False, False])

    # 時別の予報が無いと、通過時刻で合成した区間（夜だけ効く軸のため）も出発時点の風で走っている。
    assert winds == [None, None]
