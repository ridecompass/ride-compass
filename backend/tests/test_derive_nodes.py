"""ノードの種別と信号の交差点（`batch/derive_nodes.py`）の、点を交差点へ入れる判定と、流し直したときの値。

見ないもの: タグから種別・信号への読み替えの両側 → `test_tag_classification.py`。管理画面で変えた半径が
この段へ渡ること → `test_derive_cli.py`。
"""

import asyncpg
import pytest
import pytest_asyncio

from app.batch import derive_topology
from tests.conftest import empty_ingested_tables
from tests.source_ingest import WAY_ORIGIN, derive_nodes_at_default_radius, ingest_records, point_record, way_record

# moduleスコープのroad_graph_engine（conftest.py）の上のDBを使うため、.claude/rules/testing-backend.mdのパターン2どおり
# loop_scope="module"が必須。
pytestmark = pytest.mark.asyncio(loop_scope="module")

BASE_LON, BASE_LAT = WAY_ORIGIN
#: 経度0.001度は約90m。信号の交差点へ点を入れる半径と、信号の点をまとめる距離より十分に遠い。
STEP = 0.001
#: 経度0.0001度は約9m。半径の内側。
NEAR = 0.0001

WAYS: tuple[tuple[int, list[int]], ...] = ((100, [1, 3]), (200, [3, 5]))

#: (ノードid, 経度, 緯度, タグ)。9はどの道にも属さない信号で、ノード5のすぐ隣に立つ。
NODES: tuple[tuple[int, float, float, dict[str, str]], ...] = (
    (1, BASE_LON + STEP * 1, BASE_LAT, {}),
    (3, BASE_LON + STEP * 3, BASE_LAT, {"highway": "traffic_signals"}),
    (5, BASE_LON + STEP * 5, BASE_LAT, {}),
    (9, BASE_LON + STEP * 5 + NEAR, BASE_LAT, {"highway": "traffic_signals"}),
)


async def _ingest(conn: asyncpg.Connection, *, node_tags: dict[int, dict[str, str]] | None = None) -> None:
    """`WAYS`と`NODES`を取り込む。`node_tags`はidごとにタグを差し替える（無ければ宣言のまま）。"""
    node_tags = node_tags or {}
    position = {node_id: (lon, lat) for node_id, lon, lat, _ in NODES}
    await ingest_records("osm_way", [
        way_record(way_id, [position[n] for n in node_ids], node_ids)
        for way_id, node_ids in WAYS], conn=conn)
    await ingest_records("osm_node", [
        point_record(node_id, lon, lat, node_tags.get(node_id, tags))
        for node_id, lon, lat, tags in NODES], conn=conn)


async def _places(conn: asyncpg.Connection) -> dict[int, int]:
    """点ごとの、入る信号の交差点の番号（入らない点は無い）。"""
    return {r["osm_node_id"]: r["place_id"] for r in await conn.fetch("SELECT osm_node_id, place_id FROM signal_place_nodes")}


@pytest_asyncio.fixture(loop_scope="module")
async def node_conn(derive_conn):
    """テストごとに同じ生データから作り直す。生データのタグを書き換えるテストがあるため。"""
    await empty_ingested_tables(derive_conn)
    await _ingest(derive_conn)
    await derive_topology.derive(derive_conn)
    await derive_nodes_at_default_radius(derive_conn)
    return derive_conn


async def test_a_point_near_a_signal_enters_its_intersection_and_a_far_one_does_not(node_conn):
    """信号の点から半径の内にある点（信号の点自身を含む）だけが、その信号の交差点に入る。まとめる距離より離れた信号は別の交差点。"""
    places = await _places(node_conn)

    assert set(places) == {3, 5, 9}
    assert places[5] == places[9] != places[3]
    assert await node_conn.fetchval("SELECT count(*) FROM signal_places") == 2


async def _values(conn: asyncpg.Connection) -> dict[int, tuple[bool, bool]]:
    """`NODES`の点ごとの (種別が付いているか, 信号の交差点に入るか)。"""
    rows = await conn.fetch(
        "SELECT n.id, k.kind IS NOT NULL AS has_kind, sp.place_id IS NOT NULL AS in_place"
        " FROM unnest($1::bigint[]) AS n(id) LEFT JOIN node_kinds k ON k.osm_node_id = n.id"
        " LEFT JOIN signal_place_nodes sp ON sp.osm_node_id = n.id", [node_id for node_id, *_ in NODES])
    return {r["id"]: (r["has_kind"], r["in_place"]) for r in rows}


async def test_rerun_on_changed_input_keeps_no_value_the_input_no_longer_supports(node_conn):
    """入力を変えて流し直すと、今の生データでは値の出ない行に前回の値が残らない。タグが消えたノードは種別を失い、
    信号が消えれば、その交差点に入っていた点も入らなくなる。"""
    before = await _values(node_conn)
    await _ingest(node_conn, node_tags={3: {}, 9: {}})
    await derive_nodes_at_default_radius(node_conn)
    after = await _values(node_conn)

    # 前提: 1回目は値が出ている。
    assert before == {1: (False, False), 3: (True, True), 5: (False, True), 9: (True, True)}
    assert after == dict.fromkeys(before, (False, False))
