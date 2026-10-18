"""`domain/attributes.py: ground_elevation_values_sql`——区間の頂点列の標高から、区間の地表の標高の値を出すSQL。

PostGISで実行して、返った行を見る。

ここで見ないもの:
- 区間ごとの頂点列と標高を作り、結果を派生の表へ書くこと → `test_derive_elevation.py`
- 地表の標高から勾配と、橋・トンネルの上り下りを読む式 → `test_material_values.py`
"""

from decimal import Decimal

import pytest
from sqlalchemy import text

from app.domain.attributes import ground_elevation_values_sql

pytestmark = pytest.mark.asyncio(loop_scope="module")


async def values(session, segments: dict[tuple[int, int], list]) -> dict:
    """`{(道, 区間番号): [頂点ごとの標高（Noneは欠損）]}`をSQLへ通し、`{(道, 区間番号): 行}`で返す。"""
    rows = [f"({way}, {segment}, {ord_}, {'NULL' if elev is None else repr(float(elev))}::float8)"
            for (way, segment), elevations in segments.items()
            for ord_, elev in enumerate(elevations, start=1)]
    relation = f"SELECT * FROM (VALUES {', '.join(rows)}) AS v(osm_way_id, segment_index, ord, elev)"
    result = await session.execute(text(ground_elevation_values_sql(relation)))
    return {
        (row.osm_way_id, row.segment_index): {
            key: (float(value) if isinstance(value, Decimal) else value)
            for key, value in row._mapping.items()
            if key not in ("osm_way_id", "segment_index")
        }
        for row in result
    }


async def one(session, elevations) -> dict:
    return (await values(session, {(1, 0): elevations}))[(1, 0)]


async def test_a_road_that_climbs_and_descends_counts_both(road_graph_session):
    assert await one(road_graph_session, [100.0, 106.0, 104.0]) == {
        "start_ground_m": 100.0, "end_ground_m": 104.0,
        "ground_gain_m": 6.0, "ground_loss_m": 2.0, "ground_at_ends": True}


async def test_the_climb_is_rounded_to_a_tenth_of_a_metre_and_the_ends_are_kept_as_they_are(road_graph_session):
    """両端の標高は、読む側が勾配を出す前に丸めの誤差を積まないよう、丸めずに出る。"""
    row = await one(road_graph_session, [100.04, 103.37])

    assert (row["start_ground_m"], row["end_ground_m"]) == (100.04, 103.37)
    assert row["ground_gain_m"] == 3.3


async def test_a_vertex_without_elevation_is_left_out_of_the_climb(road_graph_session):
    """欠損を挟んだ2点の差は上り下りに入れない。両端の値は欠損の外から出る。"""
    assert await one(road_graph_session, [100.0, None, 110.0, 111.0]) == {
        "start_ground_m": 100.0, "end_ground_m": 111.0,
        "ground_gain_m": 1.0, "ground_loss_m": 0.0, "ground_at_ends": True}


@pytest.mark.parametrize("elevations", [
    [None, 50.0, 52.0],
    [50.0, 52.0, None],
])
async def test_a_missing_first_or_last_vertex_moves_the_end_inward_and_is_marked(road_graph_session, elevations):
    """端の頂点に標高が無いと、両端の差は区間の一部の差になる。読む側が区間の長さで割らないよう、そう印を付ける。"""
    row = await one(road_graph_session, elevations)

    assert (row["start_ground_m"], row["end_ground_m"], row["ground_at_ends"]) == (50.0, 52.0, False)


async def test_a_segment_with_fewer_than_two_known_vertices_has_no_row(road_graph_session):
    rows = await values(road_graph_session, {(1, 0): [100.0, None, None], (3, 0): [100.0, 101.0]})

    assert set(rows) == {(3, 0)}


async def test_segments_are_computed_separately(road_graph_session):
    rows = await values(road_graph_session, {(1, 0): [0.0, 3.0], (1, 1): [3.0, 0.0]})

    assert {key: (row["ground_gain_m"], row["ground_loss_m"]) for key, row in rows.items()} == {
        (1, 0): (3.0, 0.0), (1, 1): (0.0, 3.0)}
