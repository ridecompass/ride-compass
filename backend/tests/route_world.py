"""ルート生成を公開の入口から確かめるテストが共有する、小さな道路網とその渡し口。

3×3の格子（1辺約1km。長さの要るテストには大きな格子・任意の道と地点の道路網も）を`RoadNetwork`で組み、プロセス境界（DB・道路網の置き場・天気の予報ファイル）だけを代役にして、
本物の`GraphService`・エンジンの組み立て（`services/route_generation_setup.py: assemble_route_generation_setup`）・戦略層を通す。

使う側: `test_route_generation_behavior.py`（戦略層の入口）・`test_routes_generate.py`（HTTPの入口）・
`test_routing.py`（生成の経路がPythonから呼ぶJIT）・`test_route_generator.py`（経由地の無い周回の指定だけ）。
"""

from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import replace

import numpy as np

from app.services.route_generation_setup import assemble_route_generation_setup
from app.domain.geo import bearing_between, haversine_distance_km
from app.domain.graph import node_key, parse_edge_key
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.landcover import LANDCOVER_CLASSES
from app.domain.traffic import stop_count_material_ids
from app.domain.road_avoidance import AvoidanceLevel
from app.domain.road_network import RoadNetwork
from app.domain.route import Coordinates
from app.domain.route_preference import RoutePreference
from app.domain.route_request import FixedPoints, RequestedConditions
from app.domain.tuning import TUNING_VALUES
from app.domain.wind import WindForecastSeries
from app.infrastructure import road_network_store
from app.services.graph_service import GraphService, SearchMemory
from app.services.weather_service import WeatherService
from tests.axis_system_fixture import axis_definition, replaced_axis_definitions

#: 道の区分の条件と0次ハードフィルタが読む事実の列。
HIGHWAY, TUNNEL = "highway", "has_tunnel"
#: 経由地も目的地も置かない周回の指定。
NO_POINTS = FixedPoints(waypoints=[], destination=None)

AVOID_AXIS = "avoid"
BAD_MATERIAL = "m_bad"
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
    勾配はどの道も平ら（0%）で、`gradient_of`（道→始点から終点へ登る%）の道だけその勾配（逆向きは下り）を持ち、`no_gradient_ways`だけ値が無い。停止要因（信号・一時停止等）はどの道にも無い（0件）。
    `stop_density_of`（道→1kmあたりの回数）の道だけ、どの種類の停止要因もその密度で持つ。
    標高はどの道にも無く、`elevation_of`（道→(始点, 終点)の標高m）の道だけ持つ（獲得・損失は両端の差）。
    道路の種類（`HIGHWAY`）はどの道も生活道路（residential）で、`motorway_ways`だけ高速道路。トンネル（`TUNNEL`）は`tunnel_ways`だけ。
    ほかのタグの事実は無く、区分（`tests/road_class_fixture.py`で入れる）はこの2つの事実から決まる。
    土地被覆の割合はどの道にも無く、`landcover_of`（道→割合の材料のid→%）の道だけ持つ。"""
    node_ids = np.array(sorted({osm for pair in ways.values() for osm in pair}), dtype=np.int64)
    rows: list[tuple[int, bool, int, int]] = []
    for way, (start, end) in sorted(ways.items()):
        rows.append((way, True, start, end))
        if way not in oneway_ways:
            rows.append((way, False, end, start))
    lat = np.array([coordinates[int(i)][0] for i in node_ids])
    lon = np.array([coordinates[int(i)][1] for i in node_ids])
    row_of = {int(osm): i for i, osm in enumerate(node_ids)}
    tail = np.array([row_of[a] for _w, _f, a, _b in rows], dtype=np.int32)
    head = np.array([row_of[b] for _w, _f, _a, b in rows], dtype=np.int32)
    n = len(rows)
    way_of_row = np.array([w for w, _f, _a, _b in rows], dtype=np.int64)
    forward = np.array([f for _w, f, _a, _b in rows])
    points = [(Coordinates(latitude=lat[a], longitude=lon[a]), Coordinates(latitude=lat[b], longitude=lon[b]))
              for a, b in zip(tail, head, strict=True)]
    bad = (np.isin(way_of_row, list(bad_ways)) | (np.isin(way_of_row, list(bad_forward_ways)) & forward)).astype(float)
    gradient = np.where(np.isin(way_of_row, list(no_gradient_ways)), np.nan, 0.0)
    for way, percent in (gradient_of or {}).items():
        gradient[way_of_row == way] = np.where(forward[way_of_row == way], percent, -percent)
    stop_count = np.zeros(n)
    for way, density in (stop_density_of or {}).items():
        stop_count[way_of_row == way] = density
    start_elevation = np.full(n, np.nan)
    end_elevation = np.full(n, np.nan)
    for way, (start_m, end_m) in (elevation_of or {}).items():
        start_elevation[way_of_row == way] = np.where(forward[way_of_row == way], start_m, end_m)
        end_elevation[way_of_row == way] = np.where(forward[way_of_row == way], end_m, start_m)
    climb = end_elevation - start_elevation
    return RoadNetwork(
        revision=1,
        node_osm_id=node_ids, node_lat=lat, node_lon=lon,
        node_has_signals=np.zeros(len(node_ids), dtype=bool), node_max_rank=np.zeros(len(node_ids), dtype=np.int64),
        edge_way_id=way_of_row, edge_segment=np.zeros(n, dtype=np.int32),
        edge_forward=forward,
        edge_from=tail, edge_to=head,
        edge_highway=np.zeros(n, dtype=np.int16), highway_vocab=("residential",),
        edge_min_lon=np.minimum(lon[tail], lon[head]), edge_min_lat=np.minimum(lat[tail], lat[head]),
        edge_max_lon=np.maximum(lon[tail], lon[head]), edge_max_lat=np.maximum(lat[tail], lat[head]),
        edge_start_bearing_deg=np.full(n, np.nan), edge_end_bearing_deg=np.full(n, np.nan),
        numeric_ids=(BAD_MATERIAL, GRADIENT_PERCENT, *stop_count_material_ids(), TUNNEL,
                     *(c.percent_field for c in LANDCOVER_CLASSES)),
        numeric_values=np.column_stack([
            bad, gradient, *(stop_count for _ in stop_count_material_ids()),
            np.isin(way_of_row, list(tunnel_ways)).astype(float),
            *(np.array([(landcover_of or {}).get(int(way), {}).get(c.percent_field, np.nan) for way in way_of_row])
              for c in LANDCOVER_CLASSES),
        ]),
        categorical_ids=(HIGHWAY,),
        categorical_codes=np.where(np.isin(way_of_row, list(motorway_ways)), 2, 1).astype(np.int16)[:, None],
        categorical_vocab=((None, "residential", "motorway"),),
        distance_m=np.array([haversine_distance_km(a, b) * 1000 for a, b in points]),
        bearing_deg=np.array([bearing_between(a, b) for a, b in points]),
        mid_lat=(lat[tail] + lat[head]) / 2, mid_lon=(lon[tail] + lon[head]) / 2,
        start_elevation_m=start_elevation, end_elevation_m=end_elevation,
        elevation_gain_m=np.maximum(climb, 0.0), elevation_loss_m=np.maximum(-climb, 0.0),
    )


# --- 道路網をエンジンへ渡す道具（エンジンの入口の形が変わったら、ここだけを直す） ---


class NetworkRepository:
    """DBの代役。道路網はどこでも取込範囲の中で、区間の形は両端のノードを結ぶ直線。"""

    def __init__(self, network: RoadNetwork):
        self._coordinates = {
            node_key(int(osm)): [float(lat), float(lon)]
            for osm, lat, lon in zip(network.node_osm_id, network.node_lat, network.node_lon, strict=True)
        }

    async def is_covered(self, bbox):
        return True

    async def get_edges_with_geometry(self, edges):
        return {
            edge.edge_id: replace(edge, geometry=[self._coordinates[edge.from_node_id], self._coordinates[edge.to_node_id]])
            for edge in edges
        }


class Weather:
    """天気の代役。出発時点の風は無く、時別の風の予報は`series`（Noneなら無し）を返す。雨の観測は本物の
    `WeatherService`から読む（Redisの履歴。`tests/rain_history_fake.py: observe`で作る）。"""

    def __init__(self, series: WindForecastSeries | None = None):
        self._series = series
        self._rain = WeatherService()

    async def get_departure_wind(self, origin):
        return None

    async def get_wind_forecast_lattice(self, bbox):
        return self._series

    async def get_station_rain_materials(self, now):
        return await self._rain.get_station_rain_materials(now)


def serve_road_network(monkeypatch, current: Callable[[], RoadNetwork]) -> None:
    """道路網全体の配列を置き場から読まず、`current`が返すものとして読ませる（`road_network_store.current`の差し替え）。"""
    monkeypatch.setattr(road_network_store, "current", current)


def generator_for(
    monkeypatch, network: RoadNetwork, avoid_weight: float, wind: WindForecastSeries | None,
    *, assumed_speed_kmh: float = 20.0, road_avoidance: dict[str, AvoidanceLevel] | None = None,
):
    """道路網を全体の配列として読ませ、本物の`GraphService`とエンジンの上に戦略層（`RouteGenerator`）を組む。
    主観と時間の換算レートは1（難易度100の道が体感で2倍の時間）にする。"""
    serve_road_network(monkeypatch, lambda: network)
    monkeypatch.setitem(TUNING_VALUES, "evaluation.penalty_strength", 1.0)
    return assemble_route_generation_setup(
        GraphService(NetworkRepository(network), SearchMemory()), Weather(wind),
        RequestedConditions(
            preference_override=RoutePreference(weights={AVOID_AXIS: avoid_weight}),
            road_avoidance=road_avoidance or {}, assumed_speed_kmh=assumed_speed_kmh,
        ),
    ).generator


@contextmanager
def avoid_axis_declared():
    """避けたい材料が1の区間ほど難しいと評価する公開軸を1本だけ宣言する。"""
    with replaced_axis_definitions({AVOID_AXIS: axis_definition(AVOID_AXIS, material=BAD_MATERIAL, is_published=True)}):
        yield


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
