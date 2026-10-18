"""区間と道に付く数の値（`batch/derive_counts.py`）が、意図した区間へ数を付けること。

見るもの: 道路網に乗らない停止要因、信号の近くの横断歩道を信号として数える呼び出し、流し直しで数が0へ戻ること（区間と道の和）、
数えるものの無い区間・道も0の行を持つこと。
見ないもの: 停止要因と交差点の数え方（場所1つを経路の上で1回） → `test_derive_stop_counts.py`。タグから
種別・数える種別への読み替えの両側 → `test_tag_classification.py`。事故の数 → `test_derive_accidents.py`。
生データから消えた道の行が残らないことは`derive_topology`が表を空にして入れ直すことで、外すと主キーの重複で作り直しが落ちる。
"""

import asyncpg
import pytest
import pytest_asyncio

from app.batch import derive_counts, derive_nodes, derive_topology
from app.domain.geo import KM_PER_DEGREE_LATITUDE
from app.domain.traffic import POI_COUNT_KINDS, poi_count_column
from app.domain.tuning import TUNING_PARAMETERS_BY_ID
from tests.conftest import empty_ingested_tables
from tests.source_ingest import WAY_ORIGIN, WAY_STEP, ingest_records, point_record, way_record, zigzag_point

# road_graph_session（conftest.py）と同じDBを使うため、.claude/rules/testing-backend.mdのパターン2どおり
# loop_scope="module"が必須。
pytestmark = pytest.mark.asyncio(loop_scope="module")

BASE_LON, BASE_LAT = WAY_ORIGIN
STEP = WAY_STEP

#: (wayのid, 参照ノードid列)。3本ともノード3で接する。
WAYS: tuple[tuple[int, list[int]], ...] = (
    (300, [1, 3]),
    (200, [3, 4]),
    (100, [5, 3]),
)
TIED_NODE = 3
#: 道300（ノード1から3へ東西に延びる）の中ほど。ほかの道はここから約90m以上離れる。
BESIDE_WAY = (BASE_LON + STEP * 2, BASE_LAT + STEP)

CROSSING = {"highway": "crossing"}


def _road(way_id: int, node_ids: list[int]):
    return way_record(way_id, [zigzag_point(n) for n in node_ids], node_ids)


def _north_of_way(meters: float) -> tuple[float, float]:
    """道300の中ほどから北へ`meters`離れた点。"""
    lon, lat = BESIDE_WAY
    return (lon, lat + meters / (KM_PER_DEGREE_LATITUDE * 1000.0))


async def _derive_with_nodes(conn: asyncpg.Connection,
                             nodes: dict[int, tuple[tuple[float, float], dict[str, str]]]) -> None:
    """{ノードid: (位置, タグ)} のノードを取り込み、ノードの段から流し直す。"""
    await ingest_records("osm_node", [
        point_record(node_id, lon, lat, tags) for node_id, ((lon, lat), tags) in nodes.items()], conn=conn)
    await derive_nodes.derive(conn, TUNING_PARAMETERS_BY_ID["signal.match_radius_m"].default)
    await derive_counts.derive(conn)


async def _stop_counts(conn: asyncpg.Connection) -> dict[int, dict[str, float]]:
    """道ごとの、停止要因の集計キーごとの数（0は省く）。"""
    columns = {kind: poi_count_column(kind) for kind in sorted(POI_COUNT_KINDS)}
    rows = await conn.fetch(
        "SELECT osm_way_id, " + ", ".join(columns.values()) + " FROM way_counts")
    return {r["osm_way_id"]: {kind: r[c] for kind, c in columns.items() if r[c]} for r in rows}


@pytest_asyncio.fixture(loop_scope="module")
async def counts_conn(derive_conn):
    """テストごとに同じ生データから作り直す。どのテストも生データと派生の表を書き換えるため。"""
    conn = derive_conn
    await empty_ingested_tables(conn)
    await ingest_records("osm_way", [_road(*way) for way in WAYS], conn=conn)
    await derive_topology.derive(conn)
    await derive_counts.derive(conn)
    return conn


async def test_a_crossing_near_a_signal_is_counted_as_a_signal(counts_conn):
    """近くに信号がある横断歩道は、横断歩道ではなく信号として数える。

    地図も同じ読み替えで信号の点を出す（`test_point_tiles.py`）。信号のノード9は道から北へ約10mで、
    どの区間にも乗らない。
    """
    lon, lat = zigzag_point(TIED_NODE)
    await _derive_with_nodes(counts_conn, {
        TIED_NODE: ((lon, lat), CROSSING), 9: ((lon, lat + 0.0001), {"highway": "traffic_signals"})})

    rows = await counts_conn.fetch(
        "SELECT DISTINCT m.poi_signal, m.poi_crossing FROM edge_counts m JOIN road_edges e"
        "  ON e.osm_way_id = m.osm_way_id AND e.segment_index = m.segment_index"
        " WHERE $1 IN (e.from_node_id, e.to_node_id)", TIED_NODE)
    assert [(r["poi_signal"] > 0, r["poi_crossing"]) for r in rows] == [(True, 0)]


async def test_rerun_on_changed_input_keeps_no_count_the_input_no_longer_supports(counts_conn):
    """入力を変えて流し直すと、停止要因の無くなった区間・道の数は0へ戻る。道の数は区間の和。"""
    columns = tuple(poi_count_column(k) for k in sorted(POI_COUNT_KINDS))
    total = " + ".join(f"sum({c})" for c in columns)

    async def counted() -> tuple[float, float]:
        """(区間の数の総和, 道の数の総和)。"""
        return (await counts_conn.fetchval(f"SELECT {total} FROM edge_counts"),
                await counts_conn.fetchval(f"SELECT {total} FROM way_counts"))

    await _derive_with_nodes(counts_conn, {TIED_NODE: (zigzag_point(TIED_NODE), CROSSING)})
    before = await counted()
    await _derive_with_nodes(counts_conn, {TIED_NODE: (zigzag_point(TIED_NODE), {})})
    after = await counted()

    assert before[0] > 0 and before[1] == before[0]
    assert after == (0, 0)


async def test_every_segment_and_way_has_a_row_even_without_anything_to_count(counts_conn):
    """数えるものの無い区間・道も0の行を持つ。行が無いと、その区間は材料の欠損に数えられ、地図では値の無い道に塗られる。"""
    edges = await counts_conn.fetch("SELECT e.osm_way_id, c.poi_signal FROM road_edges e"
                                    " LEFT JOIN edge_counts c USING (osm_way_id, segment_index)")
    ways = await counts_conn.fetch("SELECT w.osm_way_id, c.poi_signal FROM road_ways w"
                                   " LEFT JOIN way_counts c USING (osm_way_id)")

    assert {r["osm_way_id"]: r["poi_signal"] for r in edges} == {300: 0, 200: 0, 100: 0}
    assert {r["osm_way_id"]: r["poi_signal"] for r in ways} == {300: 0, 200: 0, 100: 0}


async def test_a_stop_point_on_no_segment_is_not_counted(counts_conn):
    """どの区間にも乗らない停止要因の点（取り込んでいない道の上の点等）は、すぐ隣の道にも数えない。"""
    await _derive_with_nodes(counts_conn, {9: (_north_of_way(5.0), {"highway": "stop"})})

    assert await _stop_counts(counts_conn) == {100: {}, 200: {}, 300: {}}
