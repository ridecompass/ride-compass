"""区間の断面の点から、区間の標高と勾配の要約を出す2つの実装——派生の段のSQL（`domain/attributes.py: elevation_values_sql`。
揺れの閾値で間引いてから出す）と、道路網の配列を作るときの`domain/elevation_profile.py: profile_summaries`（間引いたあとの点から出す）。

要約のテストは、同じ点を両方へ通して同じ値を見る（`summarize`）。SQLはPostGISで実行して返った行を見る。点は道に沿って1歩
（`STEP_M`）おきに置く。間引き・丸め・行の有無を見るテストはSQLだけに当て、そのほかは閾値を0にする——一直線に並んだ点だけが
間引かれ、勾配は高低差÷間そのものになる。

ここで見ないもの:
- 区間ごとの頂点列と標高を作り、結果を派生の表へ書くこと → `test_derive_elevation.py`
- `ElevationAttribute.reversed_as`そのものの入れ替え → `test_attributes.py`
- 橋・トンネルの区間を両端の2点だけで測ること → `test_derive_elevation.py`
"""

from decimal import Decimal

from functools import partial

from app.domain.attributes import STEEPEST_MIN_INTERVAL_M, elevation_values_sql
from app.domain.elevation_profile import (
    FLAT,
    MAX_PLAUSIBLE_GRADE_PERCENT,
    SUMMARY_COLUMNS,
    along_fractions,
    flatten_spans,
    profile_summaries,
)
import numpy as np
import pytest
from sqlalchemy import text
from tests.profile_fixture import profiles


pytestmark = pytest.mark.asyncio(loop_scope="module")

STEP_M = 100.0


def rise(percent: float, steps: int = 1) -> float:
    """`steps`歩ぶんの水平距離で、勾配`percent`になる高さ。"""
    return STEP_M * steps * percent / 100


async def values(session, segments: dict[tuple[int, int], list], along=None, tolerance_m: float = 0.0) -> dict:
    """`{(道, 区間番号): [点ごとの標高（Noneは欠損）]}`を揺れの閾値`tolerance_m`でSQLへ通し、`{(道, 区間番号): 行}`で返す。
    点の道のりの位置は`along`（`{(道, 区間番号): [位置]}`）が持つ区間はその値、ほかは1歩おき。"""
    rows = []
    for (way, segment), elevations in segments.items():
        positions = (along or {}).get((way, segment), [ord_ * STEP_M for ord_ in range(len(elevations))])
        for ord_, (elev, along_m) in enumerate(zip(elevations, positions, strict=True)):
            elev_sql = "NULL" if elev is None else repr(float(elev))
            rows.append(f"({way}, {segment}, {ord_}, {along_m}::float8, {elev_sql}::float8)")
    relation = (f"SELECT * FROM (VALUES {', '.join(rows)})"
                " AS v(osm_way_id, segment_index, ord, along_m, elev)")
    result = await session.execute(text(elevation_values_sql(relation, f"{tolerance_m}::float8")))
    return {
        (row.osm_way_id, row.segment_index): {
            key: (float(value) if isinstance(value, Decimal) else value)
            for key, value in row._mapping.items()
            if key not in ("osm_way_id", "segment_index")
        }
        for row in result
    }


def _array_summary(elevations: list, along: list | None) -> dict:
    """`profile_summaries`の1区間の要約（値の無い列はNone）。点の位置は区間の長さ（最後の点の位置）に対する割合で渡す。"""
    positions = np.array(along if along is not None else [i * STEP_M for i in range(len(elevations))], dtype=np.float64)
    length = positions[-1]
    summary = profile_summaries(
        np.zeros(1, dtype=np.int64), np.array([len(elevations)], dtype=np.int64), np.ones(1, dtype=np.bool_),
        np.array([np.nan if e is None else e for e in elevations], dtype=np.float32),
        (positions / length if length > 0 else np.linspace(0.0, 1.0, len(elevations))).astype(np.float32),
        np.array([length]), STEEPEST_MIN_INTERVAL_M)[0]
    return {name: None if np.isnan(value) else float(value) for name, value in zip(SUMMARY_COLUMNS, summary, strict=True)}


@pytest.fixture(params=["sql", "array"])
def summarize(request, road_graph_session):
    """要約を出す実装（`values`と同じ口）。SQLは閾値0で通す。"""
    if request.param == "sql":
        return partial(values, road_graph_session)

    async def run(segments: dict[tuple[int, int], list], along=None) -> dict:
        return {key: _array_summary(elevations, (along or {}).get(key)) for key, elevations in segments.items()}
    return run


async def one(run, elevations, along=None) -> dict:
    rows = await run({(1, 0): elevations}, along=None if along is None else {(1, 0): along})
    return rows[(1, 0)]


async def test_a_road_that_climbs_and_descends_counts_both(summarize):
    row = await one(summarize, [100.0, 100.0 + rise(6), 100.0 + rise(6) - rise(2)])

    assert row["start_elevation_m"] == 100.0
    assert row["end_elevation_m"] == pytest.approx(100.0 + rise(4), abs=0.05)
    assert row["elevation_gain_m"] == pytest.approx(rise(6), abs=0.05)
    assert row["elevation_loss_m"] == pytest.approx(rise(2), abs=0.05)
    assert row["average_grade"] == pytest.approx(2.0, abs=0.005)


async def test_values_are_rounded_to_a_tenth_of_a_metre_and_a_hundredth_of_a_percent(road_graph_session):
    row = await one(partial(values, road_graph_session), [100.04, 100.04 + rise(3.333)])

    assert row["start_elevation_m"] == 100.0
    assert row["average_grade"] == 3.33


async def test_missing_first_and_last_vertices_move_the_ends_inward(summarize):
    row = await one(summarize, [None, 50.0, 50.0 + rise(2), None])

    assert (row["start_elevation_m"], row["end_elevation_m"]) == (50.0, pytest.approx(50.0 + rise(2), abs=0.05))
    assert row["average_grade"] == pytest.approx(2.0, abs=0.005)


async def test_a_segment_with_fewer_than_two_known_vertices_has_no_row(road_graph_session):
    rows = await values(
        road_graph_session,
        {(1, 0): [100.0, None, None], (3, 0): [100.0, 101.0]},
    )

    assert set(rows) == {(3, 0)}


async def test_grades_are_measured_along_the_road(summarize):
    """距離は点の道のりの位置の差で測る。曲がって戻る道は直線では近いが、勾配は走る長さで割る（直線で割ると大きく出る）。"""
    row = await one(summarize, [100.0, 100.0 + rise(3, 3)], along=[0.0, 3 * STEP_M])

    assert row["average_grade"] == pytest.approx(3.0, abs=0.005)
    assert row["steepest_gain_percent"] == pytest.approx(3.0, abs=0.005)


@pytest.mark.parametrize(("length_m", "steepest"), [(STEEPEST_MIN_INTERVAL_M * 0.5, None), (STEEPEST_MIN_INTERVAL_M, 10.0)])
async def test_an_interval_shorter_than_the_minimum_is_not_the_steepest(summarize, length_m, steepest):
    """一番急な勾配は、最短の長さより短い間を数えない（標高データの揺れが短い間の勾配を大きく揺らす）。平均勾配と獲得標高は
    道のりのとおり数える。"""
    row = await one(summarize, [10.0, 10.0 + length_m * 0.1], along=[0.0, length_m])

    assert row["steepest_gain_percent"] == (None if steepest is None else pytest.approx(steepest, abs=0.005))
    assert row["average_grade"] == pytest.approx(10.0, abs=0.005)


async def test_fluctuations_within_the_tolerance_are_removed(road_graph_session):
    """閾値以下の上下は揺れとして消え、獲得標高にも残す点にも入らない。"""
    row = await one(partial(values, road_graph_session, tolerance_m=0.3), [10.0, 10.2, 9.9, 10.1, 10.0])

    assert (row["elevation_gain_m"], row["elevation_loss_m"]) == (0.0, 0.0)
    assert row["elevation_profile_along_m"] == [0.0, 4 * STEP_M]


async def test_a_short_steep_rise_beyond_the_tolerance_keeps_its_points(road_graph_session):
    """閾値を越える短い急坂は、間引いたあとも坂の上下の点が残る（平らな前後に均されない）。"""
    row = await one(partial(values, road_graph_session, tolerance_m=0.3), [10.0, 10.0, 10.0 + rise(12), 10.0 + rise(12), 10.0 + rise(12)])

    assert row["elevation_profile_along_m"] == [0.0, STEP_M, 2 * STEP_M, 4 * STEP_M]


async def test_a_missing_point_is_kept_and_not_simplified_across(road_graph_session):
    """値の無い点は残し、その前後の値のある点の続きを別々に間引く（欠けた所をまたいで均さない）。"""
    row = await one(partial(values, road_graph_session, tolerance_m=0.3), [10.0, 10.1, 10.0, None, 20.0, 20.1, 20.0])

    assert row["elevation_profile_m"] == [10.0, 10.0, None, 20.0, 20.0]
    assert row["elevation_profile_along_m"] == [0.0, 2 * STEP_M, 3 * STEP_M, 4 * STEP_M, 6 * STEP_M]


@pytest.mark.parametrize(
    ("percent", "kept"),
    [
        (MAX_PLAUSIBLE_GRADE_PERCENT - 0.5, True),
        (MAX_PLAUSIBLE_GRADE_PERCENT + 0.5, False),
    ],
)
async def test_an_implausible_step_is_not_counted(summarize, percent, kept):
    """公道としてありえない勾配の間は、標高データの読み違いとして平均勾配にも獲得にも数えない。"""
    row = await one(summarize, [0.0, rise(percent)])

    assert (row["average_grade"] is not None) is kept
    assert row["elevation_gain_m"] == pytest.approx(rise(percent) if kept else 0.0, abs=0.05)


async def test_a_road_is_graded_at_its_own_point_spacing(summarize):
    """勾配は点の間隔そのもので測る（決まった幅で割り直すと、間隔が違うぶん勾配が違って出る）。"""
    spacing = STEP_M * 0.6
    row = await one(summarize, [0.0, 6.0], along=[0.0, spacing])

    assert row["steepest_gain_percent"] == pytest.approx(6.0 / spacing * 100, abs=0.005)


async def test_the_steepest_is_measured_from_the_mean_of_the_two_previous_points(summarize):
    """一番急は、1つ前の2点の標高の平均から今の点までで測る（GraphHopper の max_slope）。平らな間のあとの 10% の間は、
    10 ÷（100 + 100/2）で 6.67%。下りは逆向きに走ったときの登りで、逆の順に見ると 10% の間の前に間が無いので、
    その次の平らな間の終わりの点で（10 − 10/2）÷ 150 の 3.33%。登って下る区間でも打ち消し合わず、どちらも0以上。"""
    row = await one(summarize, [0.0, 0.0, rise(10), rise(10), 0.0])

    assert row["steepest_gain_percent"] == pytest.approx(rise(10) / (1.5 * STEP_M) * 100, abs=0.005)
    assert row["steepest_loss_percent"] == pytest.approx(rise(10) / 2 / (1.5 * STEP_M) * 100, abs=0.005)


@pytest.mark.parametrize("elevations", [
    [0.0, 0.0, rise(10), rise(10), 0.0],
    [100.0, 100.0 + rise(3), None, 100.0 + rise(8), 100.0 + rise(6), 100.0 + rise(9)],
    [10.0, 10.0 + rise(7), 10.0 + rise(2), 10.0 + rise(12), 10.0 + rise(1)],
], ids=["平らのあとの坂", "値の無い点", "登り下り"])
async def test_the_steepest_descent_is_the_steepest_climb_ridden_the_other_way(summarize, elevations):
    """同じ点を逆に並べた区間では、一番急な登りと下りが入れ替わる（逆向きの区間は入れ替えで作る）。"""
    along = [STEP_M * i for i in range(len(elevations))]
    rows = await summarize({(1, 0): elevations, (1, 1): elevations[::-1]},
                           along={(1, 0): along, (1, 1): along})

    forward, backward = rows[(1, 0)], rows[(1, 1)]
    assert (forward["steepest_gain_percent"], forward["steepest_loss_percent"]) == (
        pytest.approx(backward["steepest_loss_percent"], abs=0.005), pytest.approx(backward["steepest_gain_percent"], abs=0.005))


# 境界ちょうどの長さは使わない（配列は点の位置を区間の長さに対する割合で持つので、ちょうどの長さを丸めで外す）。
@pytest.mark.parametrize(("previous_m", "counted"), [(STEEPEST_MIN_INTERVAL_M * 0.75, False), (STEEPEST_MIN_INTERVAL_M * 1.25, True)])
async def test_a_point_after_a_short_interval_is_not_measured(summarize, previous_m, counted):
    """1つ前の間が最短の長さ以下なら、その点では測らない（区間の両端の勾配だけが残る）。"""
    climb_m = 50.0
    row = await one(summarize, [0.0, 0.0, 5.0], along=[0.0, previous_m, previous_m + climb_m])

    from_mean = 5.0 / (climb_m + previous_m / 2) * 100
    end_to_end = 5.0 / (climb_m + previous_m) * 100
    assert row["steepest_gain_percent"] == pytest.approx(from_mean if counted else end_to_end, abs=0.005)


async def test_a_road_that_only_climbs_has_no_steepest_descent(summarize):
    row = await one(summarize, [100.0, 100.0 + rise(2), 100.0 + rise(6)])

    assert (row["steepest_gain_percent"], row["steepest_loss_percent"]) == (pytest.approx(rise(5) / (1.5 * STEP_M) * 100, abs=0.005), 0.0)


async def test_the_steepest_is_measured_in_each_stretch_between_uncounted_intervals(summarize):
    """数えない間（値の無い点・ありえない勾配）で途切れた区間は、途切れない続きごとを1つの区間として測る——欠けた所の
    向こうの下りも、一番急な下りに数える。"""
    row = await one(summarize, [100.0, 100.0 + rise(3), None, 100.0 + rise(8), 100.0 + rise(6)])

    assert (row["steepest_gain_percent"], row["steepest_loss_percent"]) == (pytest.approx(3.0, abs=0.005), pytest.approx(2.0, abs=0.005))


async def test_segments_are_computed_separately(summarize):
    rows = await summarize({(1, 0): [0.0, rise(3)], (1, 1): [0.0, -rise(3)], (2, 0): [5.0, 5.0]})

    assert rows[(1, 0)]["average_grade"] == pytest.approx(3.0, abs=0.005)
    assert rows[(1, 1)]["average_grade"] == pytest.approx(-3.0, abs=0.005)
    assert rows[(2, 0)]["average_grade"] == 0.0


@pytest.mark.parametrize(
    ("elevations", "length_m"),
    [
        ([0.0, 50.0, 50.0], 2 * STEP_M),
        ([10.0, None, 12.0], 2 * STEP_M),
        ([10.0, 12.0], 0.0),
        ([0.0, rise(MAX_PLAUSIBLE_GRADE_PERCENT + 5) / 4], STEP_M / 4),
        ([100.0, 100.0 + rise(3), None, 100.0 + rise(8), 100.0 + rise(6), 100.0 + rise(6) + rise(45)], 5 * STEP_M),
    ],
    ids=["ありえない間", "値の無い点", "長さ0", "短いありえない間", "混ざった道"],
)
async def test_the_summary_counts_the_same_steps_as_the_travel_time(road_graph_session, elevations, length_m):
    """地図の色・0次ハードフィルタ・区間の詳細が読む要約の列と、所要時間が走る点の間とが、同じ間を勾配として数える——
    食い違うと、同じ道を地図と所要時間が別の勾配で見る。所要時間の側は、SQLが間引いて残した点と位置を道路網と同じに読む。"""
    count = len(elevations)
    row = await one(partial(values, road_graph_session, tolerance_m=0.3), elevations,
                    along=[length_m * i / (count - 1) for i in range(count)])
    kept = row["elevation_profile_m"]
    built = profiles(kept, positions=[list(along_fractions(np.array(row["elevation_profile_along_m"]), len(kept)))])
    _, lengths, grades = flatten_spans(built.start, built.points, built.forward, built.elevation_m, built.position,
                                       np.array([length_m]), np.zeros(1), FLAT.grade, FLAT.share)
    rises = lengths.astype(np.float64) * grades

    assert row["elevation_gain_m"] == pytest.approx(rises.clip(min=0).sum(), abs=0.05)
    assert row["elevation_loss_m"] == pytest.approx((-rises).clip(min=0).sum(), abs=0.05)
    if len(lengths) == 0:
        assert (row["average_grade"], row["steepest_gain_percent"], row["steepest_loss_percent"]) == (None, None, None)
    else:
        assert row["average_grade"] == pytest.approx(rises.sum() / lengths.sum() * 100, abs=0.005)
