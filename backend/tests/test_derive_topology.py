"""道路網の形の導出（`batch/derive_topology.py`）が、意図した形の派生を作ること。

見るのは、切る位置・閉じた区間の切り直し・枝数・区間の形と、長さと方位の測り方。
長さと方位は、緯線に沿って東へ延びる道（`PARALLEL_WAY`）の、座標から手で出せる値と比べる。

ここで見ないもの:
- 区間の端点がノードの行を持つこと——`road_edges`の端点の外部キー（`derived_models.py`）が断る
- 表へ入れられない区間（方位が無い・長さ0）を落とすこと——ここの道はどれも長さと方位を持ち、
  落とす分岐を通さない
"""

import math

import pytest
import pytest_asyncio

from app.batch import derive_topology
from tests.source_ingest import WAY_ORIGIN, WAY_STEP, ingest_records, way_record

# moduleスコープのroad_graph_engine（conftest.py）の上のDBを使うため、.claude/rules/testing-backend.mdのパターン2どおり
# loop_scope="module"が必須。
pytestmark = pytest.mark.asyncio(loop_scope="module")

#: 座標そのものに意味は無く、測地線長が0にならない間隔であればよい。
BASE_LON, BASE_LAT = WAY_ORIGIN

#: (wayのid, 参照ノードid列)。ノード3は2本の道が通るので切る位置になる。
#: ノード10で閉じる道は、中間でもう1回切られて自己ループでなくなる。
WAYS: tuple[tuple[int, list[int]], ...] = (
    (100, [1, 2, 3, 4]),
    (200, [3, 5]),
    (300, [10, 11, 12, 10]),
)


#: 緯線に沿って東へ延びる1区間の道（wayのid, 始点・終点のノードid, 緯度, 始点の経度, 経度の差）。
#: 2点が同じ緯度にあり、長さと方位を楕円体の式から手で出せる。ほかの道と離すため緯度をずらす。
PARALLEL_WAY = (400, [20, 21], 35.60, BASE_LON, 0.01)

#: WGS84の長半径（m）と扁平率。
WGS84_A, WGS84_F = 6378137.0, 1 / 298.257223563


#: ノードidから座標を作る。閉じる道の終端だけ始点と同じ位置へ戻す。
def _point(node_id: int, ordinal: int) -> tuple[float, float]:
    index = 0 if node_id == 10 and ordinal == 3 else node_id
    return (BASE_LON + WAY_STEP * index, BASE_LAT + WAY_STEP * (index % 3))


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def topology_conn(derive_conn):
    """道を取り込み、区間まで作った状態。"""
    parallel_id, parallel_nodes, lat, lon, d_lon = PARALLEL_WAY
    await ingest_records("osm_way", [
        *(way_record(way_id, [_point(n, i) for i, n in enumerate(node_ids)], node_ids) for way_id, node_ids in WAYS),
        way_record(parallel_id, [(lon, lat), (lon + d_lon, lat)], parallel_nodes),
    ], conn=derive_conn)
    await derive_topology.derive(derive_conn)
    return derive_conn


async def test_splits_where_two_ways_pass_the_same_node(topology_conn):
    """2本の道が通るノードで切る。1回しか通らない中間のノードでは切らない。"""
    rows = await topology_conn.fetch(
        "SELECT osm_way_id, segment_index, from_node_id, to_node_id FROM road_edges"
        " WHERE osm_way_id IN (100, 200) ORDER BY osm_way_id, segment_index")
    assert [(r["osm_way_id"], r["segment_index"], r["from_node_id"], r["to_node_id"])
            for r in rows] == [
        # ノード2は道100しか通らないので切らない。
        (100, 0, 1, 3),
        (100, 1, 3, 4),
        (200, 0, 3, 5),
    ]


async def test_closed_segment_is_split_again_so_no_self_loop_remains(topology_conn):
    """始点＝終点の区間は中間でもう1回切る（閉じた線に方位が定義できないため）。"""
    rows = await topology_conn.fetch(
        "SELECT segment_index, from_node_id, to_node_id FROM road_edges"
        " WHERE osm_way_id = 300 ORDER BY segment_index")
    assert [(r["from_node_id"], r["to_node_id"]) for r in rows] == [(10, 11), (11, 10)]


async def test_branch_count_is_the_number_of_segment_ends_at_the_node(topology_conn):
    """枝数は「そこに集まる道の本数」＝区間の端点としての出現回数。"""
    rows = await topology_conn.fetch(
        "SELECT osm_node_id, branch_count FROM road_nodes ORDER BY osm_node_id")
    assert {r["osm_node_id"]: r["branch_count"] for r in rows} == {
        1: 1,   # 道100の始端
        3: 3,   # 道100の2区間が接し、道200が出る
        4: 1,
        5: 1,
        10: 2,  # 閉じた道の両端
        11: 2,  # 切り直しで生まれた端点
        20: 1,  # 緯線に沿う道の両端
        21: 1,
        # ノード2・12は区間の端にならないので行が無い。
    }


async def _parallel_edge(conn):
    return await conn.fetchrow(
        "SELECT distance_m, bearing_deg, reverse_bearing_deg FROM road_edges WHERE osm_way_id = $1", PARALLEL_WAY[0])


async def test_distance_is_the_geodesic_length_of_the_geometry(topology_conn):
    """長さは形状から導ける値そのもの。測地線（楕円体）で測り、丸めない。

    丸めないのは、4.8 cmの区間が0へ落ちないようにするため。球で近似しないのは、
    費用が変わらないのに近似になるため。期待値は緯線の弧長（卯酉線の曲率半径×cos緯度×経度の差）で、
    1 kmに満たない区間では測地線長との差が1 mmに届かない。球で測ると2 mずれる。
    """
    _, _, lat, _, d_lon = PARALLEL_WAY
    sin_lat = math.sin(math.radians(lat))
    prime_vertical_radius = WGS84_A / math.sqrt(1 - WGS84_F * (2 - WGS84_F) * sin_lat**2)
    expected = prime_vertical_radius * math.cos(math.radians(lat)) * math.radians(d_lon)

    assert (await _parallel_edge(topology_conn))["distance_m"] == pytest.approx(expected, abs=0.01)


async def test_bearings_are_measured_from_the_shape_ends(topology_conn):
    """順方向は始点→終点、逆向きは終点→始点で測る（+180°の単純反転にしない）。

    同じ緯度の2点を結ぶ測地線は極の側へ膨らむので、始点では真東より北へ、終点から戻る向きは真西より北へ、
    同じ角だけ傾く（傾きは atan(sin緯度×tan(経度の差/2))）。+180°で反転すると逆向きが真西より南へ傾き、
    経度緯度を平面として測ると傾きが0になる。
    """
    _, _, lat, _, d_lon = PARALLEL_WAY
    tilt = math.degrees(math.atan(math.sin(math.radians(lat)) * math.tan(math.radians(d_lon / 2))))

    edge = await _parallel_edge(topology_conn)
    assert (edge["bearing_deg"], edge["reverse_bearing_deg"]) == (
        pytest.approx(90 - tilt, abs=1e-4),
        pytest.approx(270 + tilt, abs=1e-4),
    )


async def test_geometry_follows_the_shape_between_the_cut_points(topology_conn):
    """区間の形状は、切った位置の間の頂点をそのまま並べたもの。"""
    row = await topology_conn.fetchrow(
        "SELECT ST_NumPoints(geom) AS n, ST_AsText(ST_StartPoint(geom)) AS head"
        " FROM road_edges WHERE osm_way_id = 100 AND segment_index = 0")
    # ノード1・2・3の3頂点（中間のノード2は切らないが形状には残る）。
    assert row["n"] == 3
    assert row["head"].startswith("POINT(139.701 ")
