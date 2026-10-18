"""区間と道に付く事故の数（`batch/derive_accidents.py`）が、意図した区間へ数を付けること。

見るもの: 事故を付ける区間（等距離のタイ・地上の距離・帰属の距離の両側・自転車の関わらない事故・死亡の重み）、
流し直しで数が0へ戻ること（区間と道の和）、事故の無い区間・道も0の行を持つこと。
"""

import asyncpg
import pytest
import pytest_asyncio

from app.batch import derive_accidents, derive_topology
from app.domain.accident import (
    ACCIDENT_FATAL_WEIGHT,
    ACCIDENT_MATCH_MAX_DISTANCE_M,
    PartyType,
)
from app.domain.geo import KM_PER_DEGREE_LATITUDE, km_per_degree_longitude
from app.infrastructure.source_models import ACCIDENTS_SOURCE_SQL, PARTY_TYPE_CODES
from tests.conftest import empty_ingested_tables
from tests.source_ingest import WAY_ORIGIN, WAY_STEP, ingest_records, point_record, way_record, zigzag_point

pytestmark = pytest.mark.asyncio(loop_scope="module")

BASE_LON, BASE_LAT = WAY_ORIGIN
STEP = WAY_STEP

#: (wayのid, 参照ノードid列)。3本ともノード3で接する。ノード3の上で起きた事故は
#: 3区間のどれからも距離0になる。
WAYS: tuple[tuple[int, list[int]], ...] = (
    (300, [1, 3]),
    (200, [3, 4]),
    (100, [5, 3]),
)
TIED_NODE = 3
#: 道300（ノード1から3へ東西に延びる）の中ほど。ほかの道はここから約90m以上離れる。
BESIDE_WAY = (BASE_LON + STEP * 2, BASE_LAT + STEP)

#: 自転車の当事者種別と、自転車ではない軽車両（その他）の当事者種別。
BICYCLE_PARTY = PARTY_TYPE_CODES[PartyType.BICYCLE]
OTHER_PARTY = "59"


def _road(way_id: int, node_ids: list[int]):
    return way_record(way_id, [zigzag_point(n) for n in node_ids], node_ids)


def _north_of_way(meters: float) -> tuple[float, float]:
    """道300の中ほどから北へ`meters`離れた点。"""
    lon, lat = BESIDE_WAY
    return (lon, lat + meters / (KM_PER_DEGREE_LATITUDE * 1000.0))


def _accident(key: str, position: tuple[float, float], *, bicycle: bool = True, fatal: bool = False):
    """本票の列名で当事者種別と死者数を持つ事故の1件。"""
    return point_record(key, *position, {
        "当事者種別（当事者A）": BICYCLE_PARTY if bicycle else OTHER_PARTY,
        "当事者種別（当事者B）": OTHER_PARTY,
        "死者数": "001" if fatal else "000"})


async def _ingest_accidents(conn: asyncpg.Connection, *accidents) -> None:
    """ノード3の上の事故に`accidents`を加えて、事故を取り込み直す。"""
    await ingest_records("accident", [_accident("tied", zigzag_point(TIED_NODE)), *accidents], conn=conn)


async def _accidents(conn: asyncpg.Connection) -> dict[tuple[int, int], float]:
    """事故の付いた区間ごとの数。"""
    rows = await conn.fetch(
        "SELECT osm_way_id, segment_index, accident_count FROM edge_accidents"
        " WHERE accident_count > 0")
    return {(r["osm_way_id"], r["segment_index"]): r["accident_count"] for r in rows}


@pytest_asyncio.fixture(loop_scope="module")
async def accidents_conn(derive_conn):
    """テストごとに同じ生データから作り直す。どのテストも生データと派生の表を書き換えるため。"""
    conn = derive_conn
    await empty_ingested_tables(conn)
    await ingest_records("osm_way", [_road(*way) for way in WAYS], conn=conn)
    await _ingest_accidents(conn)
    await derive_topology.derive(conn)
    await derive_accidents.derive(conn)
    return conn


async def test_equidistant_accident_goes_to_exactly_one_existing_segment(accidents_conn):
    """等距離のタイでも事故は1件のまま、実在する1区間へ付く。区間の鍵が小さい方が取る。

    鍵の2列を別々の探索で取ると、タイのときに片方ずつ別の区間を指し、どの区間にも
    付かない（存在しない組へ集計される）ことがある。
    """
    assert await _accidents(accidents_conn) == {(100, 0): 1.0}
    distances = await accidents_conn.fetch(
        f"SELECT DISTINCT e.geom <-> a.geom AS d FROM road_edges e, {ACCIDENTS_SOURCE_SQL} a")
    # 前提: 3区間とも本当に等距離（タイを作れている）。
    assert [r["d"] for r in distances] == [0.0]


async def test_an_accident_without_a_bicycle_is_not_counted(accidents_conn):
    """自転車の関わらない事故は数えない（自転車の事故はノード3の事故）。"""
    await _ingest_accidents(accidents_conn, _accident("car", _north_of_way(5.0), bicycle=False))

    await derive_accidents.derive(accidents_conn)

    assert await _accidents(accidents_conn) == {(100, 0): 1.0}


async def test_an_accident_farther_than_the_match_distance_is_not_counted(accidents_conn):
    """道から帰属の距離より遠い事故は、最も近い道にも付けない。距離の内側の事故は付ける。"""
    await _ingest_accidents(accidents_conn,
                            _accident("near", _north_of_way(ACCIDENT_MATCH_MAX_DISTANCE_M - 10)),
                            _accident("far", _north_of_way(ACCIDENT_MATCH_MAX_DISTANCE_M + 10)))

    await derive_accidents.derive(accidents_conn)

    assert await _accidents(accidents_conn) == {(100, 0): 1.0, (300, 0): 1.0}


async def test_an_accident_goes_to_the_segment_nearest_on_the_ground(accidents_conn):
    """事故は地上の距離（m）で最も近い区間へ付く。

    道300から北へ11.5m・南北に延びる道400から西へ10mの点は、道400の方が近い。緯度経度の度の
    まま比べると、東西の10mは南北の11.5mより大きな度になる（経度1度が緯度1度より短い）。
    """
    lon, lat = _north_of_way(11.5)
    east = lon + 10.0 / (km_per_degree_longitude(lat) * 1000.0)
    south, north = _north_of_way(6.5)[1], _north_of_way(40.0)[1]
    await ingest_records("osm_way", [*(_road(*way) for way in WAYS),
                                     way_record(400, [(east, south), (east, north)], [7, 8])], conn=accidents_conn)
    await _ingest_accidents(accidents_conn, _accident("between", (lon, lat)))

    await derive_topology.derive(accidents_conn)
    await derive_accidents.derive(accidents_conn)

    assert await _accidents(accidents_conn) == {(100, 0): 1.0, (400, 0): 1.0}


async def test_only_a_fatal_accident_is_weighted(accidents_conn):
    """死亡事故は重みの件数分、死亡以外の事故（ノード3の事故）は1件と数える。"""
    await _ingest_accidents(accidents_conn, _accident("fatal", _north_of_way(5.0), fatal=True))

    await derive_accidents.derive(accidents_conn)

    assert await _accidents(accidents_conn) == {(100, 0): 1.0, (300, 0): ACCIDENT_FATAL_WEIGHT}


async def test_every_segment_and_way_has_a_row_and_a_rerun_without_accidents_returns_them_to_zero(accidents_conn):
    """事故の無い区間・道も0の行を持ち、道の数は区間の和。行が無いと、その区間は材料の欠損に数えられ、地図では値の無い道に
    塗られる。事故を消して流し直すと、どの区間・道も0へ戻る。"""
    async def counts() -> tuple[dict[int, float], dict[int, float]]:
        edges = await accidents_conn.fetch("SELECT e.osm_way_id, c.accident_count FROM road_edges e"
                                           " LEFT JOIN edge_accidents c USING (osm_way_id, segment_index)")
        ways = await accidents_conn.fetch("SELECT w.osm_way_id, c.accident_count FROM road_ways w"
                                          " LEFT JOIN way_accidents c USING (osm_way_id)")
        return ({r["osm_way_id"]: r["accident_count"] for r in edges},
                {r["osm_way_id"]: r["accident_count"] for r in ways})

    before = await counts()
    await ingest_records("accident", [], conn=accidents_conn)
    await derive_accidents.derive(accidents_conn)

    assert before == ({300: 0.0, 200: 0.0, 100: 1.0},) * 2
    assert await counts() == ({300: 0.0, 200: 0.0, 100: 0.0},) * 2
