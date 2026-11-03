"""`domain/attributes.py: elevation_values_sql`——区間の断面の点列の標高から、区間の標高と勾配を出すSQL。

PostGISで実行して、返った行を見る。点は道に沿って1歩（`STEP_M`）おきに置き、断面の刻み（ならす幅）も1歩にする——
間が刻み以上なら、勾配は高低差÷間そのものになる。

ここで見ないもの:
- 区間ごとの頂点列と標高を作り、結果を派生の表へ書くこと → `test_derive_elevation.py`
- `ElevationAttribute.reversed_as`そのものの入れ替え → `test_attributes.py`
"""

from decimal import Decimal

from app.domain.attributes import elevation_values_sql
from app.domain.elevation_profile import MAX_PLAUSIBLE_GRADE_PERCENT
import pytest
from sqlalchemy import text


pytestmark = pytest.mark.asyncio(loop_scope="module")

STEP_M = 100.0


def rise(percent: float, steps: int = 1) -> float:
    """`steps`歩ぶんの水平距離で、勾配`percent`になる高さ。"""
    return STEP_M * steps * percent / 100


async def values(session, segments: dict[tuple[int, int], list], on_structure=frozenset(), along=None) -> dict:
    """`{(道, 区間番号): [点ごとの標高（Noneは欠損）]}`をSQLへ通し、`{(道, 区間番号): 行}`で返す。点の道のりの位置は
    `along`（`{(道, 区間番号): [位置]}`）が持つ区間はその値、ほかは1歩おき。"""
    rows = []
    for (way, segment), elevations in segments.items():
        structure = "true" if (way, segment) in on_structure else "false"
        positions = (along or {}).get((way, segment), [ord_ * STEP_M for ord_ in range(len(elevations))])
        for ord_, (elev, along_m) in enumerate(zip(elevations, positions, strict=True)):
            elev_sql = "NULL" if elev is None else repr(float(elev))
            rows.append(f"({way}, {segment}, {ord_}, {along_m}::float8, {elev_sql}::float8, {structure})")
    relation = (f"SELECT * FROM (VALUES {', '.join(rows)})"
                " AS v(osm_way_id, segment_index, ord, along_m, elev, on_structure)")
    result = await session.execute(text(elevation_values_sql(relation, f"{STEP_M}::float8")))
    return {
        (row.osm_way_id, row.segment_index): {
            key: (float(value) if isinstance(value, Decimal) else value)
            for key, value in row._mapping.items()
            if key not in ("osm_way_id", "segment_index")
        }
        for row in result
    }


async def one(session, elevations, on_structure=False, along=None) -> dict:
    rows = await values(session, {(1, 0): elevations}, on_structure={(1, 0)} if on_structure else frozenset(),
                        along=None if along is None else {(1, 0): along})
    return rows[(1, 0)]


async def test_a_road_that_climbs_and_descends_counts_both(road_graph_session):
    row = await one(road_graph_session, [100.0, 100.0 + rise(6), 100.0 + rise(6) - rise(2)])

    assert row["start_elevation_m"] == 100.0
    assert row["end_elevation_m"] == pytest.approx(100.0 + rise(4), abs=0.05)
    assert row["elevation_gain_m"] == pytest.approx(rise(6), abs=0.05)
    assert row["elevation_loss_m"] == pytest.approx(rise(2), abs=0.05)
    assert row["average_grade"] == pytest.approx(2.0, abs=0.005)


async def test_values_are_rounded_to_a_tenth_of_a_metre_and_a_hundredth_of_a_percent(road_graph_session):
    row = await one(road_graph_session, [100.04, 100.04 + rise(3.333)])

    assert row["start_elevation_m"] == 100.0
    assert row["average_grade"] == 3.33


async def test_a_vertex_without_elevation_is_left_out(road_graph_session):
    """欠損を挟んだ2点の差は獲得・喪失に入れない。両端の値と平均勾配は欠損の外から出る。"""
    row = await one(road_graph_session, [100.0, None, 100.0 + rise(5, 2), 100.0 + rise(5, 2) + rise(1)])

    assert row["start_elevation_m"] == 100.0
    assert row["elevation_gain_m"] == pytest.approx(rise(1), abs=0.05)
    assert row["elevation_loss_m"] == 0.0
    assert row["average_grade"] == pytest.approx((rise(5, 2) + rise(1)) / (3 * STEP_M) * 100, abs=0.005)


async def test_missing_first_and_last_vertices_move_the_ends_inward(road_graph_session):
    row = await one(road_graph_session, [None, 50.0, 50.0 + rise(2), None])

    assert (row["start_elevation_m"], row["end_elevation_m"]) == (50.0, pytest.approx(50.0 + rise(2), abs=0.05))
    assert row["average_grade"] == pytest.approx(2.0, abs=0.005)


async def test_a_segment_with_fewer_than_two_known_vertices_has_no_row(road_graph_session):
    rows = await values(
        road_graph_session,
        {(1, 0): [100.0, None, None], (3, 0): [100.0, 101.0]},
    )

    assert set(rows) == {(3, 0)}


async def test_gaps_only_between_known_vertices_give_no_climb_but_still_an_average(road_graph_session):
    row = await one(road_graph_session, [100.0, None, 100.0 + rise(3, 2)])

    assert (row["elevation_gain_m"], row["elevation_loss_m"]) == (0.0, 0.0)
    assert row["average_grade"] == pytest.approx(3.0, abs=0.005)


async def test_grades_are_measured_along_the_road(road_graph_session):
    """距離は点の道のりの位置の差で測る。曲がって戻る道は直線では近いが、勾配は走る長さで割る（直線で割ると大きく出る）。"""
    row = await one(road_graph_session, [100.0, 100.0 + rise(3, 3)], along=[0.0, 3 * STEP_M])

    assert row["average_grade"] == pytest.approx(3.0, abs=0.005)
    assert row["steepest_gain_percent"] == pytest.approx(3.0, abs=0.005)


async def test_a_rise_over_less_than_the_step_is_spread_over_the_step(road_graph_session):
    """刻みより短い間の高低差は、刻みの幅でならして一番急な勾配にする（数十mの跳ね上がりを、その短さのまま勾配にしない）。
    平均勾配は道のりのとおり。"""
    row = await one(road_graph_session, [10.0, 12.0], along=[0.0, STEP_M / 4])

    assert row["steepest_gain_percent"] == pytest.approx(2.0 / STEP_M * 100, abs=0.005)
    assert row["average_grade"] == pytest.approx(2.0 / (STEP_M / 4) * 100, abs=0.005)


@pytest.mark.parametrize(
    ("elevations", "gain", "loss"),
    [
        ([100.0, 60.0, 70.0, 100.0 + rise(1, 3)], rise(1, 3), 0.0),
        ([100.0, 140.0, 100.0 - rise(2, 2)], 0.0, rise(2, 2)),
    ],
    ids=["上る橋", "下る橋"],
)
async def test_a_structure_uses_only_its_two_ends(road_graph_session, elevations, gain, loss):
    """橋の途中の頂点は下の谷を指すので、谷の起伏を獲得・喪失に入れない。"""
    row = await one(road_graph_session, elevations, on_structure=True)

    assert row["elevation_gain_m"] == pytest.approx(gain, abs=0.05)
    assert row["elevation_loss_m"] == pytest.approx(loss, abs=0.05)


@pytest.mark.parametrize(
    ("percent", "kept"),
    [
        (MAX_PLAUSIBLE_GRADE_PERCENT - 0.5, True),
        (MAX_PLAUSIBLE_GRADE_PERCENT + 0.5, False),
    ],
)
async def test_an_implausible_average_grade_has_no_value(road_graph_session, percent, kept):
    """平均勾配が公道としてありえない区間は、平均勾配を持たない。獲得・喪失と両端の標高はそのまま出る。"""
    row = await one(road_graph_session, [0.0, rise(percent)])

    assert (row["average_grade"] is not None) is kept
    assert row["elevation_gain_m"] + row["elevation_loss_m"] == pytest.approx(abs(rise(percent)), abs=0.05)


async def test_a_road_longer_than_the_step_is_graded_at_its_own_point_spacing(road_graph_session):
    """刻みより長い区間は、点の間隔そのもので勾配を測る（刻みの幅で割り直すと、間隔が刻みより狭いぶん勾配が小さく出る）。"""
    spacing = STEP_M * 0.6
    row = await one(road_graph_session, [0.0, 6.0, 6.0], along=[0.0, spacing, 2 * spacing])

    assert row["steepest_gain_percent"] == pytest.approx(6.0 / spacing * 100, abs=0.005)


async def test_vertices_at_the_same_place_give_no_grade(road_graph_session):
    row = await one(road_graph_session, [10.0, 12.0], along=[0.0, 0.0])

    assert row["elevation_gain_m"] == 2.0
    assert row["average_grade"] is None


async def test_the_steepest_climb_and_descent_are_taken_between_neighbouring_points(road_graph_session):
    """登って下る区間でも打ち消し合わず、登りと下りのそれぞれで一番急な間を出す（どちらも0以上）。"""
    row = await one(road_graph_session, [100.0, 100.0 + rise(3), 100.0 + rise(3) + rise(8), 100.0 + rise(3) + rise(8) - rise(5)])

    assert row["steepest_gain_percent"] == pytest.approx(8.0, abs=0.005)
    assert row["steepest_loss_percent"] == pytest.approx(5.0, abs=0.005)


async def test_a_road_that_only_climbs_has_no_steepest_descent(road_graph_session):
    row = await one(road_graph_session, [100.0, 100.0 + rise(2), 100.0 + rise(6)])

    assert (row["steepest_gain_percent"], row["steepest_loss_percent"]) == (pytest.approx(4.0, abs=0.005), 0.0)


async def test_an_implausible_step_does_not_count_as_the_steepest(road_graph_session):
    """公道としてありえない勾配の間は、標高データの読み違いとして一番急な勾配に数えない。数えられる間が1つも無ければ、
    平らとは言えないので値を持たない。"""
    implausible = rise(MAX_PLAUSIBLE_GRADE_PERCENT + 5)
    rows = await values(road_graph_session, {(1, 0): [0.0, rise(3), rise(3) + implausible], (2, 0): [0.0, implausible]})

    assert rows[(1, 0)]["steepest_gain_percent"] == pytest.approx(3.0, abs=0.005)
    assert (rows[(2, 0)]["steepest_gain_percent"], rows[(2, 0)]["steepest_loss_percent"]) == (None, None)


async def test_the_steepest_slopes_skip_a_gap(road_graph_session):
    """欠損を挟んだ2点の間は勾配を測れないので、隣り合う組が無ければ一番急な勾配を持たない。"""
    row = await one(road_graph_session, [100.0, None, 100.0 + rise(9, 2)])

    assert (row["steepest_gain_percent"], row["steepest_loss_percent"]) == (None, None)


@pytest.mark.parametrize(("elevations", "gain", "loss"), [([100.0, 60.0, 100.0 + rise(4, 2)], 4.0, 0.0),
                                                         ([100.0, 140.0, 100.0 - rise(2, 2)], 0.0, 2.0)],
                         ids=["上る橋", "下る橋"])
async def test_a_structure_takes_its_steepest_slope_from_its_two_ends(road_graph_session, elevations, gain, loss):
    """橋の途中の点は下の谷を指すので、両端の差の勾配だけを一番急な勾配にする。"""
    row = await one(road_graph_session, elevations, on_structure=True)

    assert row["steepest_gain_percent"] == pytest.approx(gain, abs=0.005)
    assert row["steepest_loss_percent"] == pytest.approx(loss, abs=0.005)


async def test_segments_are_computed_separately(road_graph_session):
    rows = await values(road_graph_session, {(1, 0): [0.0, rise(3)], (1, 1): [0.0, -rise(3)], (2, 0): [5.0, 5.0]})

    assert rows[(1, 0)]["average_grade"] == pytest.approx(3.0, abs=0.005)
    assert rows[(1, 1)]["average_grade"] == pytest.approx(-3.0, abs=0.005)
    assert rows[(2, 0)]["average_grade"] == 0.0

