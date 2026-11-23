"""`tests/route_world.py`——ルート生成のテストが共有する3×3の格子の道路網。

格子の引数（一方通行・高速道路・避けたい材料・値の無い材料・孤立した道）が道路網に効いていないと、経路の
テストは宣言と違う世界の上で、別の理由で緑になりうる。区間の形を読む同じテストを、格子の道路網と、DBから派生の作り直しで
組んだ本物の道路網の両方へ流す。

ここで見ないもの:
- `Weather`（与えた値を返すだけで、本物を真似る振る舞いを持たない）
"""


import pytest

from app.batch import derive_cli
from app.domain.road_network import RoadNetwork, edge_row_of, edge_shape
from app.infrastructure import road_network_store
from tests.conftest import postgis_database_url
from tests.route_world import (
    COORDINATES,
    WAYS,
    grid_network,
)
from tests.source_ingest import abr_prefecture_record, ingest_records, point_record, way_record

# --- 区間の形: 格子と本物へ同じテストを流す -------------------------------------------

WAY = sorted(WAYS)[0]
START, END = WAYS[WAY]


def _shapes_run_from_the_start_node_to_the_end_node(network: RoadNetwork) -> None:
    """区間の形は、向きごとに、始点のノードから終点のノードまでの形になる。"""
    for forward, (start, end) in ((True, (START, END)), (False, (END, START))):
        row = edge_row_of(network, WAY, 0, forward)
        assert row is not None
        shape = edge_shape(network, row)
        assert shape[0] == pytest.approx(list(COORDINATES[start]))
        assert shape[-1] == pytest.approx(list(COORDINATES[end]))


def test_the_grid_shapes_each_direction_from_its_start_to_its_end():
    _shapes_run_from_the_start_node_to_the_end_node(grid_network())


@pytest.mark.asyncio(loop_scope="module")
async def test_a_network_built_from_the_database_shapes_each_direction_from_its_start_to_its_end(
        road_graph_session, road_network_root):
    await ingest_records("osm_node", [point_record(n, COORDINATES[n][1], COORDINATES[n][0]) for n in (START, END)])
    await ingest_records("osm_way", [way_record(
        WAY, [(COORDINATES[n][1], COORDINATES[n][0]) for n in (START, END)], [START, END], {"highway": "residential"})])
    await ingest_records("abr", [abr_prefecture_record("130001", "東京都", COORDINATES[START][1], COORDINATES[START][0])])
    assert await derive_cli.run(postgis_database_url()) == 0

    _shapes_run_from_the_start_node_to_the_end_node(road_network_store.current())
