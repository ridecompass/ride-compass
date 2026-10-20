"""`tests/route_world.py`——ルート生成のテストが共有する3×3の格子の道路網と、道路網の倉庫の代役。

格子の引数（一方通行・高速道路・避けたい材料・値の無い材料・孤立した道）が道路網に効いていないと、経路の
テストは宣言と違う世界の上で、別の理由で緑になりうる。倉庫の代役（`NetworkRepository`）は、区間の形を
取り直す同じテストを本物の倉庫（実DB）へも流す。

ここで見ないもの:
- `Weather`（与えた値を返すだけで、本物を真似る振る舞いを持たない）
- 本物の倉庫が取込範囲の外を断ること（代役はどこでも範囲の中にする。`test_ingested_area.py`）
"""


import pytest

from app.batch import derive_cli
from app.domain.graph import LeanEdge, edge_key, node_key
from app.domain.region import BoundingBox
from app.infrastructure.road_graph_repository import RoadGraphRepository
from tests.conftest import postgis_database_url
from tests.route_world import (
    COORDINATES,
    WAYS,
    NetworkRepository,
    grid_network,
)
from tests.source_ingest import abr_prefecture_record, ingest_records, point_record, way_record

# --- 道路網の倉庫: 本物と代役へ同じテストを流す -------------------------------------------

WAY = sorted(WAYS)[0]
START, END = WAYS[WAY]


async def _geometry_runs_from_the_start_node_to_the_end_node(repository) -> None:
    """区間の形を取り直すと、向きごとに、始点のノードから終点のノードまでの形になる。"""
    requested = [
        LeanEdge(edge_id=edge_key(WAY, 0, forward), from_node_id=node_key(a), to_node_id=node_key(b),
                 geometry=[], distance_m=0.0, osm_way_id=WAY, segment_index=0, forward=forward)
        for forward, (a, b) in ((True, (START, END)), (False, (END, START)))
    ]
    lat, lon = COORDINATES[START]
    inside = BoundingBox(min_latitude=lat, min_longitude=lon, max_latitude=lat + 0.001, max_longitude=lon + 0.001)

    edges = await repository.get_edges_with_geometry(requested)

    assert await repository.is_covered(inside)
    for edge in requested:
        geometry = edges[edge.edge_id].geometry
        start, end = (START, END) if edge.forward else (END, START)
        assert geometry[0] == pytest.approx(list(COORDINATES[start]))
        assert geometry[-1] == pytest.approx(list(COORDINATES[end]))


async def test_the_stand_in_repository_returns_each_direction_from_its_start_to_its_end():
    await _geometry_runs_from_the_start_node_to_the_end_node(NetworkRepository(grid_network()))


@pytest.mark.asyncio(loop_scope="module")
async def test_the_real_repository_returns_each_direction_from_its_start_to_its_end(
        road_graph_repository: RoadGraphRepository, road_network_root):
    await ingest_records("osm_node", [point_record(n, COORDINATES[n][1], COORDINATES[n][0]) for n in (START, END)])
    await ingest_records("osm_way", [way_record(
        WAY, [(COORDINATES[n][1], COORDINATES[n][0]) for n in (START, END)], [START, END], {"highway": "residential"})])
    await ingest_records("abr", [abr_prefecture_record("130001", "東京都", COORDINATES[START][1], COORDINATES[START][0])])
    assert await derive_cli.run(postgis_database_url()) == 0

    await _geometry_runs_from_the_start_node_to_the_end_node(road_graph_repository)
