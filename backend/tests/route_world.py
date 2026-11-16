"""ルート生成を公開の入口から確かめるテストが共有する、小さな道路網とその渡し口。

3×3の格子（1辺約1km。長さの要るテストには大きな格子・任意の道と地点の道路網も）を`RoadNetwork`で組み、プロセス境界（DB・天気の予報ファイル）だけを代役にし、道路網は本番と同じ置き場（一時ディレクトリ）から読ませて、
本物の`GraphService`・エンジンの組み立て（`services/route_generation_setup.py: assemble_route_generation_setup`）・戦略層を通す。

使う側: `test_route_generation_behavior.py`（戦略層の入口）・`test_routes_generate.py`（HTTPの入口）・
`test_search_kernels.py`（生成の経路がPythonから呼ぶJIT）・`test_route_generator.py`（経由地の無い周回の指定だけ）。
"""

import itertools
from datetime import datetime, timedelta
import shutil
from dataclasses import replace
from pathlib import Path

import numpy as np

from app.services.route_generation_setup import assemble_route_generation_setup
from app.domain.geo import haversine_distance_km
from app.domain.graph import edge_key, node_key, parse_edge_key
from app.domain.landcover import LANDCOVER_CLASSES
from app.domain.traffic import stop_count_material_ids
from app.domain.cost_preference import CostPreference
from app.domain.road_avoidance import AvoidanceLevel
from app.domain.road_network import RoadNetwork
from app.domain.route import Coordinates
from app.domain.route_request import FixedPoints, RequestedConditions
from app.domain.msm import MsmBlock, MsmGrid
from app.domain.wind import WindForecastSeries
from app.infrastructure import road_network_store
from app.services.graph_service import GraphService, SearchMemory
from tests.road_network_fixture import road_network as build_road_network

#: 道の区分の条件と0次ハードフィルタが読む事実の列。
HIGHWAY, TUNNEL = "highway", "has_tunnel"
#: 経由地も目的地も置かない周回の指定。
NO_POINTS = FixedPoints(waypoints=[], destination=None)

#: 避けたい道の材料（値1の道）。道のストレスの軸（`tests/cost_axes_fixture.py: cost_axes`）が読む。本番の軸と同じく宣言のある
#: 数の材料を使う（軸の事実は、その宣言の名前と単位で出す）。
BAD_MATERIAL = "accident_count_per_km_year"
BASE_LAT, BASE_LON = 35.60, 139.60
LAT_STEP, LON_STEP = 0.009, 0.011  # 緯度・経度とも約1km

#: 格子のノード（行, 列）→ osm_node_id。行は南から北、列は西から東。
NODE_OF = {(row, col): 10 + row * 3 + col for row in range(3) for col in range(3)}
#: 道（1本1区間）→ (始点, 終点)。横の道は西→東、縦の道は南→北。
WAYS = {
    **{100 + row * 2 + col: (NODE_OF[row, col], NODE_OF[row, col + 1]) for row in range(3) for col in range(2)},
    **{200 + row * 3 + col: (NODE_OF[row, col], NODE_OF[row + 1, col]) for row in range(2) for col in range(3)},
}
SOUTH_WEST, NORTH_EAST, CENTER = NODE_OF[0, 0], NODE_OF[2, 2], NODE_OF[1, 1]
SOUTH_EAST = NODE_OF[0, 2]


def _grid_point(row: int, col: int) -> tuple[float, float]:
    return BASE_LAT + row * LAT_STEP, BASE_LON + col * LON_STEP


COORDINATES = {osm: _grid_point(row, col) for (row, col), osm in NODE_OF.items()}
#: 北東の角のすぐ東にある、格子とつながらない短い道（2ノード）。孤立した小塊の代わり。
ISLAND_NODES = {90: (COORDINATES[NORTH_EAST][0], COORDINATES[NORTH_EAST][1] + 0.004),
                91: (COORDINATES[NORTH_EAST][0], COORDINATES[NORTH_EAST][1] + 0.008)}
ISLAND_WAY = 300
ALL_COORDINATES = {**COORDINATES, **ISLAND_NODES}


def grid_network(*, island=False, **attributes) -> RoadNetwork:
    """3×3の格子。`island`で格子とつながらない道を足す。ほかの引数は`road_network`と同じ。"""
    ways = dict(WAYS)
    if island:
        ways[ISLAND_WAY] = tuple(ISLAND_NODES)
    return road_network(ways, ALL_COORDINATES, **attributes)


def lattice_node(row: int, col: int) -> int:
    """`lattice_network`の格子のノード（行, 列）→ osm_node_id。行は南から北、列は西から東。"""
    return 1000 + row * 100 + col


def lattice_ways(size: int) -> dict[int, tuple[int, int]]:
    """`size`×`size`の格子の道（1本1区間、道→(始点, 終点)）。横の道は西→東、縦の道は南→北。"""
    ways: dict[int, tuple[int, int]] = {}
    for row in range(size):
        for col in range(size):
            if col + 1 < size:
                ways[len(ways) + 1] = (lattice_node(row, col), lattice_node(row, col + 1))
            if row + 1 < size:
                ways[len(ways) + 1] = (lattice_node(row, col), lattice_node(row + 1, col))
    return ways


def lattice_network(size: int, **attributes) -> RoadNetwork:
    """`size`×`size`の格子（1辺約1km、道は`lattice_ways`）。3×3では足りない長さ（経由地を通る周回等）を見るときに使う。
    `attributes`は`road_network`の道の性質（既定はどの道も平らで、避けたい材料を持たない）。"""
    coordinates = {lattice_node(row, col): _grid_point(row, col) for row in range(size) for col in range(size)}
    return road_network(lattice_ways(size), coordinates, **attributes)


def road_network(
    ways: dict[int, tuple[int, int]], coordinates: dict[int, tuple[float, float]],
    *, bad_ways=(), bad_forward_ways=(), oneway_ways=(), motorway_ways=(), no_gradient_ways=(),
    stop_density_of=None, gradient_of=None, elevation_of=None, tunnel_ways=(), landcover_of=None,
) -> RoadNetwork:
    """道（1本1区間、道→(始点, 終点)）とノードの地点（osm_node_id→(緯度, 経度)）から道路網を組む。

    `bad_ways`は避けたい材料が1（それ以外は0）、`bad_forward_ways`は始点→終点の向きだけ避けたい材料が1、
    `oneway_ways`は始点→終点だけ走れる。
    標高はどの道も0mで平らで、`elevation_of`（道→(始点, 終点)の標高m）の道はその標高、`gradient_of`（道→始点から終点へ登る%）の
    道は始点の0mからその勾配で登り、`no_gradient_ways`だけ標高も勾配の値も無い。停止要因（信号・一時停止等）はどの道にも無い（0件）。
    `stop_density_of`（道→1kmあたりの回数）の道だけ、どの種類の停止要因もその密度で持つ。
    道路の種類（`HIGHWAY`）はどの道も生活道路（residential）で、`motorway_ways`だけ高速道路。トンネル（`TUNNEL`）は`tunnel_ways`だけ。
    ほかのタグの事実は無く、区分（`tests/road_class_fixture.py`で入れる）はこの2つの事実から決まる。
    土地被覆の割合はどの道にも無く、`landcover_of`（道→割合の材料のid→%）の道だけ持つ。"""
    def length_m(way: int) -> float:
        (a_lat, a_lon), (b_lat, b_lon) = (coordinates[osm] for osm in ways[way])
        return haversine_distance_km(Coordinates(latitude=a_lat, longitude=a_lon),
                                     Coordinates(latitude=b_lat, longitude=b_lon)) * 1000

    elevation = {way: (0.0, 0.0) for way in ways if way not in no_gradient_ways}
    elevation |= {way: (0.0, percent / 100 * length_m(way)) for way, percent in (gradient_of or {}).items()}
    elevation |= dict(elevation_of or {})

    def bad(rows):
        return (np.isin(rows.way, list(bad_ways)) | (np.isin(rows.way, list(bad_forward_ways)) & rows.forward)).astype(float)

    def stop_count(rows):
        return np.array([(stop_density_of or {}).get(int(way), 0.0) for way in rows.way])

    def landcover(field):
        return lambda rows: [(landcover_of or {}).get(int(way), {}).get(field, np.nan) for way in rows.way]

    return build_road_network(
        coordinates, {(way, 0): pair for way, pair in ways.items()},
        oneway=[(way, 0) for way in oneway_ways], elevation_of={(way, 0): pair for way, pair in elevation.items()},
        numeric={
            BAD_MATERIAL: bad, **{material: stop_count for material in stop_count_material_ids()},
            TUNNEL: lambda rows: np.isin(rows.way, list(tunnel_ways)).astype(float),
            **{c.percent_field: landcover(c.percent_field) for c in LANDCOVER_CLASSES},
        },
        categorical={HIGHWAY: lambda rows: ["motorway" if way in motorway_ways else "residential" for way in rows.way]},
    )


# --- 道路網をエンジンへ渡す道具（エンジンの入口の形が変わったら、ここだけを直す） ---


class NetworkRepository:
    """DBの代役。区間の形は両端のノードを結ぶ直線で、断面の点は区間の両端の標高（標高の無い区間は持たない）。"""

    def __init__(self, network: RoadNetwork):
        self._coordinates = {
            node_key(int(osm)): [float(lat), float(lon)]
            for osm, lat, lon in zip(network.node_osm_id, network.node_lat, network.node_lon, strict=True)
        }
        self._profiles = {
            (int(way), int(segment), bool(forward)): ((0.0, float(start)), (1.0, float(end)))
            for way, segment, forward, start, end in zip(
                network.edge_way_id, network.edge_segment, network.edge_forward,
                network.start_elevation_m, network.end_elevation_m, strict=True)
            if not (np.isnan(start) or np.isnan(end))
        }

    async def get_edges_with_geometry(self, edges):
        return {
            edge.edge_id: replace(
                edge, geometry=[self._coordinates[edge.from_node_id], self._coordinates[edge.to_node_id]],
                profile=self._profiles.get((edge.osm_way_id, edge.segment_index, edge.forward), ()))
            for edge in edges
        }


#: 2020〜2035年の毎時の、どこでも無風の予報（格子点1つ。区間はどこでも、一番近い格子点のこの1つを引く）。
_CALM_HOURS = int((datetime(2035, 1, 1) - datetime(2020, 1, 1)).total_seconds() // 3600)
CALM = WindForecastSeries(
    times=[datetime(2020, 1, 1) + timedelta(hours=hour) for hour in range(_CALM_HOURS)],
    speed_ms=np.zeros((1, _CALM_HOURS)),
    direction_deg=np.zeros((1, _CALM_HOURS)),
    lattice=MsmBlock(grid=MsmGrid(lat_min=35.0, lon_min=139.0, d_lat=0.05, d_lon=0.0625, n_lat=1, n_lon=1),
                     row0=0, col0=0, rows=1, cols=1),
    latest_run_end=datetime(2035, 1, 1),
)


class Weather:
    """天気の代役。時別の風の予報は`series`（省けば無風の`CALM`）を返す。"""

    def __init__(self, series: WindForecastSeries = CALM):
        self._series = series

    async def get_wind_forecast_lattice(self, bbox):
        return self._series


#: 置くたびに進める道路網の世代。置き場は世代で見分けるので、中身を変えて置くたびに世代を変える。
_REVISIONS = itertools.count(1)


def serve_road_network(root: Path, network: RoadNetwork | None) -> None:
    """道路網全体の配列を、本番と同じ置き場（`road_network_store.save`）へ新しい世代として置く。`root`は
    `backend/tests/conftest.py: road_network_root`の置き場。`network`がNoneなら置き場を空にする（道路網が無い本番の状態）。"""
    if network is None:
        shutil.rmtree(root, ignore_errors=True)
    else:
        road_network_store.save(replace(network, revision=next(_REVISIONS)))


def generator_for(
    root: Path, network: RoadNetwork, wind: WindForecastSeries = CALM,
    *, assumed_speed_kmh: float = 20.0, road_avoidance: dict[str, AvoidanceLevel] | None = None,
):
    """道路網を全体の配列として置き場へ置き、本物の`GraphService`とエンジンの上に戦略層（`RouteGenerator`）を組む。"""
    serve_road_network(root, network)
    return assemble_route_generation_setup(
        GraphService(NetworkRepository(network), SearchMemory(), road_network_store.current()), Weather(wind),
        RequestedConditions(
            cost_preference=CostPreference(), road_avoidance=road_avoidance or {}, assumed_speed_kmh=assumed_speed_kmh,
        ),
    ).generator


def at(osm_node_id: int) -> Coordinates:
    lat, lon = ALL_COORDINATES[osm_node_id]
    return Coordinates(latitude=lat, longitude=lon)


def node_point(network: RoadNetwork, osm_node_id: int) -> Coordinates:
    """道路網`network`のノードの地点（`grid_network`以外の道路網の`at`）。"""
    (row,) = np.flatnonzero(network.node_osm_id == osm_node_id)
    return Coordinates(latitude=float(network.node_lat[row]), longitude=float(network.node_lon[row]))


def edges_of(candidate) -> list[tuple[int, int, bool]]:
    """候補の区間の`(道, 区間番号, 順方向)`を、通る順に。"""
    edges = []
    for edge_id in candidate.edge_ids:
        edge = parse_edge_key(edge_id)
        assert edge is not None, edge_id
        edges.append(edge)
    return edges


#: 置いた点（経由地・目的地）を通る生成を見る格子（6×6、1辺約1km）。3×3では、置いた点を通っても候補が分かれ、
#: 距離に合わせる長さが無い。
LATTICE = lattice_network(6)


def lattice_at(row: int, col: int) -> Coordinates:
    return node_point(LATTICE, lattice_node(row, col))


def lattice_ring_edges(side: int) -> list[str]:
    """`LATTICE`の南西の角（出発地）から東へ回って戻る、1辺`side`kmの正方形の周回の区間の鍵。"""
    ring = [(0, col) for col in range(side)] + [(row, side) for row in range(side)] \
        + [(side, col) for col in range(side, 0, -1)] + [(row, 0) for row in range(side, -1, -1)]
    way_of = {pair: way for way, pair in lattice_ways(6).items()}
    edges = []
    for start, end in zip(ring, ring[1:]):
        tail, head = lattice_node(*start), lattice_node(*end)
        edges.append(edge_key(way_of[tail, head], 0, True) if (tail, head) in way_of else edge_key(way_of[head, tail], 0, False))
    return edges


def passes_in_order(node_ids: list[str], start: int, stops: list[int], end: int) -> bool:
    """経路のノードの列`node_ids`が`start`から始まり、`stops`を置いた順に通り、`end`で終わる。"""
    if node_ids[0] != node_key(start) or node_ids[-1] != node_key(end):
        return False
    position = 0
    for stop in stops:
        if node_key(stop) not in node_ids[position:]:
            return False
        position = node_ids.index(node_key(stop), position)
    return True


def ways_of(candidate) -> list[int]:
    return [way for way, _, _ in edges_of(candidate)]


def nodes_of(candidate) -> list[int]:
    """候補が通るノードのOSMのid（`node_key`の逆）を、通る順に。"""
    return [int(node_id.rsplit("-", 1)[1]) for node_id in candidate.node_ids]
