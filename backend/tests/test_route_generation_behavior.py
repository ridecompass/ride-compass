"""ルート生成の振る舞いを、公開の入口（`RouteGenerator`）だけから確かめる。

小さな道路網（3×3の格子、1辺約1km）を`RoadNetwork`で組み、生成の結果（`RouteCandidate`）の性質を見る。
探索の途中状態・キャッシュ・内部の関数には触らない——道路網の持ち方やエンジンの組み立てを作り替えても、
同じ道路網と設定から同じ性質の経路が出ることを、このファイルが通り続けることで示す。

ここで見ないもの:
- 探索アルゴリズムそのもの（ダイクストラ・A*） → `test_routing.py`、ターンの費用 → `test_turn_structure.py`
- 候補の並べ方・周回の距離の幅・理由の文面・候補のidとラベル（戦略層） → `test_route_generator.py`。ここでは、エンジンが断った
  ときに候補が空になることまでを見る
- 材料の値の求め方 → `test_material_values.py`

道路網と、それをエンジンへ渡す道具は`tests/route_world.py`が持つ（HTTPの入口のテストと共有）。
"""

import logging
from collections import Counter
import math
import re
from datetime import datetime, timedelta, timezone
from itertools import accumulate, combinations

import numpy as np
import pytest

from app.domain.axis_definitions import AXIS_DEFINITIONS, AxisDefinition, BreakpointLinearShape, MaterialTerm
from app.domain.geo import KM_PER_DEGREE_LATITUDE, haversine_distance_km, km_per_degree_longitude
from app.domain.graph import node_key
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.road_classes import TRUE_FACT_VALUE
from app.domain.rain import rain_window_material_id
from app.domain.road_network import RoadNetwork
from app.domain.route import Coordinates
from app.domain.route_points import RoutePointHit
from app.domain.msm import MsmBlock, MsmGrid
from app.domain.wind import WindForecastSeries
from app.domain.time_zone import JST
from app.domain.traffic import stop_count_material_ids
from app.domain.tuning import TUNING_VALUES
from tests import rain_history_fake
from tests.axis_system_fixture import replaced_axis_definitions
from app.domain.road_classes import AvoidanceClassification, AvoidanceSection
from tests.road_class_fixture import classification, fact_is, map_layer, replaced_road_classes, road_classes
from app.domain.route_request import FixedPoints
from tests.route_world import (
    AVOID_AXIS,
    BAD_MATERIAL,
    BASE_LAT,
    BASE_LON,
    CENTER,
    COORDINATES,
    HIGHWAY,
    ISLAND_WAY,
    LATTICE,
    LAT_STEP,
    LON_STEP,
    NODE_OF,
    NORTH_EAST,
    NO_POINTS,
    SOUTH_EAST,
    SOUTH_WEST,
    TUNNEL,
    WAYS,
    at,
    avoid_axis_declared,
    edges_of,
    generator_for,
    grid_network,
    lattice_at,
    lattice_network,
    lattice_node,
    lattice_ways,
    node_point,
    nodes_of,
    passes_in_order,
    road_network,
    ways_of,
)




@pytest.fixture
def avoid_axis():
    """避けたい材料が1の区間ほど難しいと評価する公開軸を1本だけ宣言する（`avoid_weight`はこの軸の重み）。"""
    with avoid_axis_declared():
        yield


@pytest.fixture
def engine_over(monkeypatch, avoid_axis):
    """道路網から、本物のエンジンの上に戦略層（`RouteGenerator`）を組む。軸は`avoid_axis`の1本。"""

    def build(network: RoadNetwork, *, avoid_weight: float = 0.0, wind: WindForecastSeries | None = None,
              side_points=None, **conditions):
        return generator_for(monkeypatch, network, avoid_weight, wind, side_points, **conditions)

    return build


# ---------------------------------------------------------------------------------------


def assert_connected(candidate, start: int, end: int) -> None:
    """経路が`start`から始まり`end`で終わり、区間どうしが途切れずにつながる。"""
    assert candidate.node_ids[0] == node_key(start)
    assert candidate.node_ids[-1] == node_key(end)
    assert len(candidate.node_ids) == len(candidate.edge_ids) + 1
    nodes = nodes_of(candidate)
    lengths = [haversine_distance_km(at(a), at(b)) for a, b in zip(nodes, nodes[1:])]
    assert all(length > 0 for length in lengths)
    assert math.isclose(sum(lengths), candidate.distance_km, abs_tol=0.02)


def fastest_of(candidates):
    """一覧の中で所要時間が最小の候補（基準線）。"""
    return min(candidates, key=lambda c: c.estimated_duration_seconds)


async def test_destination_route_runs_from_origin_to_destination(engine_over):
    generator = engine_over(grid_network())

    candidates = await generator.generate_via_waypoints(at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=3, start_time=DEPARTURE)

    assert candidates
    for candidate in candidates:
        assert_connected(candidate, SOUTH_WEST, NORTH_EAST)
    # 格子の対角は最短で4区間（約4km）。基準線（時間最短）はそれより遠回りしない。
    fastest = fastest_of(candidates)
    assert len(fastest.edge_ids) == 4
    # 探索用の区間は形を持たない。取り直した形で、4区間ぶんの折れ線になる。
    assert len(fastest.geometry["coordinates"]) == 5


async def test_weight_on_an_axis_steers_the_route_away_from_what_it_scores_badly(engine_over):
    """南の道と東の道（南西→南東→北東）だけが避けたい材料を持つ。重みを掛けると、最も易しい候補はそこを通らない。"""
    bad = {100, 101, 202, 205}  # 南の横の道2本と東の縦の道2本
    generator = engine_over(grid_network(bad_ways=bad), avoid_weight=1.0)

    candidates = await generator.generate_via_waypoints(at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=3, start_time=DEPARTURE)

    easiest = min(candidates, key=lambda c: c.overall_difficulty.average)
    assert_connected(easiest, SOUTH_WEST, NORTH_EAST)
    assert not set(ways_of(easiest)) & bad


async def test_oneway_road_is_never_driven_against_its_direction(engine_over):
    """中央の縦の道（南→北だけ走れる）を、北→南の目的地ルートで逆走しない。"""
    oneway = {201, 204}
    generator = engine_over(grid_network(oneway_ways=oneway))

    candidates = await generator.generate_via_waypoints(
        at(NODE_OF[2, 1]), [], destination=at(NODE_OF[0, 1]), max_routes=3, start_time=DEPARTURE)

    assert candidates
    for candidate in candidates:
        assert_connected(candidate, NODE_OF[2, 1], NODE_OF[0, 1])
        assert not [way for way, _, forward in edges_of(candidate) if way in oneway and not forward]


async def test_motorway_is_never_used_even_when_short(engine_over):
    """南の横の道（近道）の西が高速道路で、近道でも通らない。"""
    motorway = {100}
    generator = engine_over(grid_network(motorway_ways=motorway))

    candidates = await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NODE_OF[0, 2]), max_routes=3, start_time=DEPARTURE)

    assert candidates
    for candidate in candidates:
        assert_connected(candidate, SOUTH_WEST, NODE_OF[0, 2])
        assert not set(ways_of(candidate)) & motorway


async def test_segments_cover_the_whole_route(engine_over):
    generator = engine_over(grid_network())

    (candidate, *_) = await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=1, start_time=DEPARTURE)

    assert math.isclose(sum(s.distance_km for s in candidate.segments), candidate.distance_km, abs_tol=0.02)


async def test_spliced_route_is_evaluated_as_sent(engine_over):
    generator = engine_over(grid_network())
    (candidate, *_) = await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=1, start_time=DEPARTURE)

    spliced = await generator.generate_spliced_route(at(SOUTH_WEST), at(NORTH_EAST), candidate.edge_ids, start_time=DEPARTURE)

    assert [c.edge_ids for c in spliced] == [candidate.edge_ids]


@pytest.mark.parametrize(
    ("origin", "destination", "edges"),
    [
        (SOUTH_WEST, NORTH_EAST, lambda edge_ids: edge_ids[:1] + edge_ids[2:]),  # 途中で途切れる
        (CENTER, NORTH_EAST, lambda edge_ids: edge_ids),  # 起点が違う
        (SOUTH_WEST, SOUTH_EAST, lambda edge_ids: edge_ids),  # 終点が違う
        (SOUTH_WEST, None, lambda edge_ids: edge_ids),  # 目的地が無いのに出発地へ戻らない
        (SOUTH_WEST, NORTH_EAST, lambda edge_ids: [*edge_ids, "way-999-seg0-fwd"]),  # 道路網に無い区間を含む
    ],
)
async def test_a_spliced_route_the_road_network_cannot_trace_is_refused(
        engine_over, caplog, origin, destination, edges):
    """断った理由は常時のログに残すが、ノード・区間のOSMのidは詳しい記録（DEBUG）にだけ載せる（公開の地図で場所をそのまま引けるため）。"""
    generator = engine_over(grid_network())
    (candidate, *_) = await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=1, start_time=DEPARTURE)

    with caplog.at_level(logging.DEBUG):
        assert await generator.generate_spliced_route(
            at(origin), None if destination is None else at(destination), edges(candidate.edge_ids),
            start_time=DEPARTURE) == []

    levels = [r.levelno for r in caplog.records if re.search(r"osm-node-|way-\d", r.getMessage())]
    assert levels and set(levels) == {logging.DEBUG}


# --- 候補の選び方 ---


async def test_fastest_route_ignores_the_axis_weights(engine_over):
    """基準線は軸の重みを一切使わない。避けたい道が最短でも、基準線はそこを通る（対価として比べる相手のため）。"""
    generator = engine_over(grid_network(bad_ways={100}), avoid_weight=5.0)

    candidates = await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(SOUTH_EAST), max_routes=3, start_time=DEPARTURE)

    fastest = fastest_of(candidates)
    assert ways_of(fastest) == [100, 101]


async def test_destination_candidates_never_ride_a_road_there_and_back(engine_over):
    """前向きと後ろ向きの探索が同じ道を通る経路は、行って戻る形になり経路として成立しない。"""
    generator = engine_over(grid_network(bad_ways={100, 101, 202, 205}), avoid_weight=1.0)

    candidates = await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=5, start_time=DEPARTURE)

    assert candidates
    for candidate in candidates:
        assert len(set(ways_of(candidate))) == len(candidate.edge_ids)


async def test_the_same_request_returns_the_same_routes(engine_over):
    """同点の候補も毎回同じ順で返す。変わると、区間の乗り換えで送り返すidが指す先が変わる。"""
    first = await engine_over(grid_network()).generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=5, start_time=DEPARTURE)
    second = await engine_over(grid_network()).generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=5, start_time=DEPARTURE)

    assert [c.edge_ids for c in first] == [c.edge_ids for c in second]


def _one_loop(loops: list[frozenset[int]]) -> bool:
    return len(loops) == 1


def _no_two_loops_share_a_road(loops: list[frozenset[int]]) -> bool:
    return all(not first & second for first, second in combinations(loops, 2))


@pytest.mark.parametrize(
    ("changed", "holds"),
    [
        # 格子より広い間隔: どの折返し点も採用済みの折返し点に近すぎ、1つしか採れない
        ({"search.min_turnaround_separation_km": 20.0}, _one_loop),
        # 重なりを許さない: どの2つの周回も道を共有しない
        ({"search.loop_max_overlap_ratio": 0.0}, _no_two_loops_share_a_road),
    ],
    ids=["turnaround_separation", "loop_overlap"],
)
async def test_the_next_loops_follow_the_choice_values_changed_in_the_admin_screen(engine_over, monkeypatch, changed, holds):
    """管理画面で変えた候補の選び方の値は、組んだ後の生成器の次の生成から効く。効かないと、較正のたびにデプロイが要る。"""
    generator = engine_over(grid_network())

    async def loops():
        candidates = await generator.generate_loops(
            at(CENTER), 4.0, 1.5, max_routes=5, start_time=DEPARTURE, points=NO_POINTS)
        return [frozenset(ways_of(c)) for c in candidates]

    assert not holds(await loops())
    for param_id, value in changed.items():
        monkeypatch.setitem(TUNING_VALUES, param_id, value)
    assert holds(await loops())


async def test_the_next_loops_search_turnarounds_within_the_radius_changed_in_the_admin_screen(engine_over, monkeypatch):
    """管理画面で探す半径の比を狭めると、次の生成から遠くの折返し点が範囲の外になり、周回の候補が減る。"""
    generator = engine_over(LATTICE)

    async def loop_count():
        candidates = await generator.generate_loops(
            lattice_at(0, 0), 12.0, 2.0, max_routes=5, start_time=DEPARTURE, points=NO_POINTS)
        return len(candidates)

    default_count = await loop_count()
    monkeypatch.setitem(TUNING_VALUES, "search.turnaround_radius_ratio", 0.1)
    assert 0 < await loop_count() < default_count


async def test_a_slow_cruise_on_roads_to_avoid_still_turns_at_the_far_side_of_the_ring(engine_over):
    """巡航5km/hで、どの道もなるべく避け（割り増しは既定の2倍）、どの道も難しい設定でも、往路が帯の上限に近い折返し点から
    周回が出る。探索の打ち切りが割り増しを見込まないと、帯の遠い側の点が木から落ち、長さの合う周回が出ない。"""
    definitions = road_classes(
        {"kind": classification({"local": [fact_is(HIGHWAY, "residential")]})},
        avoidance_sections={"s": AvoidanceSection(label="見出し", description="", sort_order=0)},
        avoidance_classifications={"kind": AvoidanceClassification(section_key="s", sort_order=0, overrides={})},
    )
    network = lattice_network(6, bad_ways=lattice_ways(6))
    with replaced_road_classes(definitions):
        generator = engine_over(
            network, avoid_weight=1.0, assumed_speed_kmh=5.0, road_avoidance={"kind.local": "avoid"})
        candidates = await generator.generate_loops(
            lattice_at(0, 0), 12.0, 0.5, max_routes=5, start_time=DEPARTURE, points=NO_POINTS)

    assert candidates
    assert all(abs(c.distance_km - 12.0) <= 0.5 for c in candidates)


def _clustered_ring_network() -> tuple[RoadNetwork, Coordinates]:
    """易しい折返し点が1か所に数千点固まる道路網（関東の網で、易しい往路の先の住宅地の細かい網が上位を占める形）と出発地。

    出発地から16方向へ1km刻みの道を6kmまで延ばし、東の1本だけを易しい道にして、その先（4.6km）を中心に
    1.1km四方の細かい格子（81×81点）を置く。ほかの15本は避けたい道。周回12km±3kmの帯（往路4.5〜6.5km）には、
    格子の全点と、15本の道の5・6km目の点が入る。"""
    origin = (BASE_LAT, BASE_LON)
    km_lon = km_per_degree_longitude(BASE_LAT)

    def offset(north_km: float, east_km: float) -> tuple[float, float]:
        return origin[0] + north_km / KM_PER_DEGREE_LATITUDE, origin[1] + east_km / km_lon

    coordinates = {1: origin}
    ways: dict[int, tuple[int, int]] = {}
    bad_ways: list[int] = []
    easy_bearing = 4
    for spoke in range(16):
        angle = math.radians(spoke * 22.5)
        steps = [1.0, 2.0, 3.0, 4.0, 4.6] if spoke == easy_bearing else [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
        previous = 1
        for step, km in enumerate(steps):
            node = 100 + spoke * 10 + step
            coordinates[node] = offset(km * math.cos(angle), km * math.sin(angle))
            ways[len(ways) + 1] = (previous, node)
            if spoke != easy_bearing:
                bad_ways.append(len(ways))
            previous = node
    side, spacing_km = 81, 1.1 / 80

    def patch_node(row: int, col: int) -> int:
        return 10_000 + row * side + col

    for row in range(side):
        for col in range(side):
            coordinates[patch_node(row, col)] = offset((row - 40) * spacing_km, 4.6 + (col - 40) * spacing_km)
            if col + 1 < side:
                ways[len(ways) + 1] = (patch_node(row, col), patch_node(row, col + 1))
            if row + 1 < side:
                ways[len(ways) + 1] = (patch_node(row, col), patch_node(row + 1, col))
    ways[len(ways) + 1] = (100 + easy_bearing * 10 + 4, patch_node(40, 40))
    return road_network(ways, coordinates, bad_ways=bad_ways), Coordinates(latitude=origin[0], longitude=origin[1])


async def test_loops_come_in_the_requested_number_even_when_the_easiest_turnarounds_crowd_into_one_place(
    engine_over, caplog,
):
    """易しい折返し点が1か所に数千点固まっていても、その外の折返し点で補い、頼んだ数の周回が出る。上位の決まった数だけを
    間引きにかけると、固まった点どうしが近すぎで捨てられて折返し点が数点しか残らず、候補が頼んだ数に届かない。"""
    network, origin = _clustered_ring_network()
    generator = engine_over(network, avoid_weight=1.0)

    with caplog.at_level(logging.INFO, logger="ridecompass.generate"):
        candidates = await generator.generate_loops(origin, 12.0, 3.0, max_routes=4, start_time=DEPARTURE, points=NO_POINTS)

    assert len(candidates) == 4
    assert not [r for r in caplog.records if "pool_unfilled" in r.getMessage()]


async def test_loop_never_drives_against_a_one_way_road(engine_over):
    oneway = {101, 103, 105, 202, 205}  # 東側の横の道（西→東だけ）と東の縦の道（南→北だけ）
    generator = engine_over(grid_network(oneway_ways=oneway))

    candidates = await generator.generate_loops(at(CENTER), 4.0, 1.5, max_routes=5, start_time=DEPARTURE, points=NO_POINTS)

    assert candidates
    for candidate in candidates:
        assert_connected(candidate, CENTER, CENTER)
        assert not [way for way, _, forward in edges_of(candidate) if way in oneway and not forward]


# --- 経由地・目的地の扱い ---


@pytest.mark.parametrize(
    ("origin", "waypoints", "destination", "distance"),
    [
        pytest.param((1, 1), [(1, 4), (4, 4)], None, None, id="距離なし・経由地を通って出発地へ戻る"),
        pytest.param((1, 1), [(2, 1)], (4, 3), None, id="距離なし・経由地を通って目的地へ"),
        pytest.param((2, 2), [(2, 3), (3, 3)], None, (12.0, 2.0), id="距離あり・経由地を通って出発地へ戻る"),
        pytest.param((1, 1), [], (4, 4), (10.0, 2.0), id="距離あり・目的地へ寄り道して"),
        pytest.param((1, 1), [(1, 3)], (4, 4), (10.0, 2.0), id="距離あり・経由地を通って目的地へ"),
    ],
)
async def test_routes_through_placed_points_keep_their_order_come_in_several_and_fit_the_distance(
    engine_over, origin, waypoints, destination, distance,
):
    """経由地は置いた順に通り（夕食のあと銭湯、の順は利用者の意図）、終点は目的地か出発地。候補は1本に限らず
    求めた数まで出て、距離を決めたときは全長が目標±許容に入る。所要時間が最短の1本（基準線）は、目的地へ距離を
    決めずに向かうときだけ含む（距離を決めると、最短の1本は目標の距離と噛み合わない）。"""
    generator = engine_over(LATTICE)
    start, stops = lattice_node(*origin), [lattice_node(*point) for point in waypoints]
    end = start if destination is None else lattice_node(*destination)
    end_point = None if destination is None else lattice_at(*destination)

    if distance is None:
        candidates = await generator.generate_via_waypoints(
            lattice_at(*origin), [lattice_at(*point) for point in waypoints], destination=end_point, max_routes=5, start_time=DEPARTURE)
    else:
        target, tolerance = distance
        candidates = await generator.generate_loops(
            lattice_at(*origin), target, tolerance, max_routes=5, start_time=DEPARTURE,
            points=FixedPoints(waypoints=[lattice_at(*point) for point in waypoints], destination=end_point))

    assert len(candidates) >= 2
    for candidate in candidates:
        assert passes_in_order(candidate.node_ids, start, stops, end)
        if distance is not None:
            assert abs(candidate.distance_km - target) <= tolerance
    assert sum(candidate.is_fastest for candidate in candidates) == (distance is None and destination is not None)


def physical_segments(candidate) -> list[frozenset[str]]:
    """経路の区間を、進行方向を問わない道の区間（両端のノードの組）で並べたもの。"""
    return [frozenset(pair) for pair in zip(candidate.node_ids, candidate.node_ids[1:])]


#: 横の道(2, *)だけが避けたい材料を持たない格子。避けたい軸に重みがあると、横の道が来た道でも、罰が無ければ帰りは
#: 横の道へ寄る。
ROW_2_ONLY = lattice_network(6, bad_ways={
    way for way, (start, end) in lattice_ways(6).items()
    if not (start // 100 % 10 == 2 and end // 100 % 10 == 2)
})


@pytest.mark.parametrize(
    ("network", "avoid_weight", "waypoints", "distance", "fixed_count"),
    [
        # 出発地(2,1) → (2,4) → (2,2) は、置いた点どうしを素直な道で結ぶと同じ横の道を戻る。最後の(2,2)→出発地の
        # 最短は走った横の道そのもの（避けなければ2度目を走る）。
        pytest.param(LATTICE, 0.0, [(2, 4), (2, 2)], None, 5, id="距離なし"),
        # 出発地(2,1) → (2,4)のあと、全長8kmの周回の残りを選ぶ。避けなければ帰りは易しい横の道（来た道）へ寄る。
        pytest.param(ROW_2_ONLY, 1.0, [(2, 4)], (8.0, 1.5), 3, id="距離あり"),
    ],
)
async def test_the_freely_chosen_part_avoids_every_road_already_ridden_but_the_placed_legs_do_not(
    engine_over, network, avoid_weight, waypoints, distance, fixed_count,
):
    """自由に選ぶ部分（最後の経由地から先）は、置いた点どうしの区間を含め、それまでに走った道を避ける。置いた点どうしの
    区間は避けずに素直な道で結ぶ（遠回りすると、置いた点の間が利用者の思う道でなくなる）。"""
    generator = engine_over(network, avoid_weight=avoid_weight)
    origin = lattice_node(2, 1)
    points = FixedPoints(waypoints=[lattice_at(*point) for point in waypoints], destination=None)

    if distance is None:
        candidates = await generator.generate_via_waypoints(
            lattice_at(2, 1), points.waypoints, destination=None, max_routes=3, start_time=DEPARTURE)
    else:
        candidates = await generator.generate_loops(
            lattice_at(2, 1), *distance, max_routes=3, start_time=DEPARTURE, points=points)

    assert candidates
    stops = [origin, *(lattice_node(*point) for point in waypoints)]
    straight = [node_key(lattice_node(2, col)) for col in range(1, 5)]
    for candidate in candidates:
        fixed_nodes = candidate.node_ids[:fixed_count + 1]
        assert [n for n in fixed_nodes if n in straight] == fixed_nodes  # 置いた点どうしは横の道のまま
        assert passes_in_order(candidate.node_ids, origin, stops[1:], origin)
        segments = physical_segments(candidate)
        free = segments[fixed_count:]
        assert not set(free) & set(segments[:fixed_count])
        assert len(set(free)) == len(free)


#: 1周8kmの輪。出発地Oから北のAを通って北東のWまで2km、反対回り（南西の4点）でWまで6km。O→A→Wの向きだけ
#: 避けたい材料を持ち、逆向き（W→A→O）は持たない。
RING_COORDINATES = {
    1: (BASE_LAT, BASE_LON),  # O
    2: (BASE_LAT + LAT_STEP, BASE_LON),  # A
    3: (BASE_LAT + LAT_STEP, BASE_LON + LON_STEP),  # W
    4: (BASE_LAT + 2 * LAT_STEP, BASE_LON + LON_STEP),
    5: (BASE_LAT + 2 * LAT_STEP, BASE_LON - LON_STEP),
    6: (BASE_LAT, BASE_LON - LON_STEP),
}
RING = road_network(
    {1: (1, 2), 2: (2, 3), 3: (3, 4), 4: (4, 5), 5: (5, 6), 6: (6, 1)}, RING_COORDINATES, bad_forward_ways={1, 2},
)


@pytest.mark.parametrize(
    ("waypoints", "expected"),
    [
        pytest.param([3], [1, 6, 5, 4, 3, 2, 1], id="経由地1つは逆に回ってよい"),
        pytest.param([2, 3], [1, 2, 3, 4, 5, 6, 1], id="経由地2つは置いた順のまま"),
    ],
)
async def test_a_loop_is_ridden_the_easier_way_round_only_when_that_keeps_the_placed_order(
    engine_over, waypoints, expected,
):
    """O→A→Wは避けたい道で、W→A→Oはそうでない。Wだけを置いた周回は、逆に回ってもWを通るので易しい向き
    （O→南西→W→A→O）で出す。A・Wの順に置いた周回は、逆に回るとWがAより先になるので、難しくても置いた順で出す。"""
    generator = engine_over(RING, avoid_weight=1.0)

    candidates = await generator.generate_via_waypoints(
        node_point(RING, 1), [node_point(RING, point) for point in waypoints], destination=None, max_routes=1, start_time=DEPARTURE)

    assert [candidate.node_ids for candidate in candidates] == [[node_key(n) for n in expected]]


def _made_alike(candidates) -> list[tuple]:
    """候補の作り方・種類・名前・逆回りが見える所（id・種類・名前・最速の印・通るノードの並び）。"""
    return [(c.id, c.kind, c.direction_label, c.is_fastest, c.node_ids) for c in candidates]


@pytest.mark.parametrize(
    ("network", "origin", "waypoints", "distance"),
    [
        pytest.param(grid_network(), CENTER, [], (4.0, 1.5), id="距離あり・経由地なし"),
        pytest.param(LATTICE, lattice_node(2, 2), [lattice_node(2, 3), lattice_node(3, 3)], (12.0, 2.0),
                     id="距離あり・経由地を通って"),
        # 逆に回ったほうが易しい輪（上のテスト）で、逆回りも同じに出ることを見る。
        pytest.param(RING, 1, [3], None, id="距離なし・経由地を通って"),
    ],
)
async def test_a_destination_on_the_origin_makes_the_same_loops_as_no_destination(
    engine_over, network, origin, waypoints, distance,
):
    """目的地を出発地に置いても、目的地を置かない周回と同じ候補（種類・方位の名前・逆回り・最速の印なし）を作る。
    違うと、同じ周回を頼んだのに、目的地の置き方で名前・回る向き・候補が変わる。"""
    generator = engine_over(network, avoid_weight=1.0)
    start = node_point(network, origin)
    stops = [node_point(network, point) for point in waypoints]

    async def generate(destination):
        if distance is None:
            return await generator.generate_via_waypoints(
                start, stops, destination=destination, max_routes=3, start_time=DEPARTURE)
        target, tolerance = distance
        return await generator.generate_loops(
            start, target, tolerance, max_routes=3, start_time=DEPARTURE,
            points=FixedPoints(waypoints=stops, destination=destination))

    without = await generate(None)
    on_origin = await generate(start)

    assert without and {c.kind for c in without} == {"loop"}
    assert _made_alike(on_origin) == _made_alike(without)


async def test_a_destination_that_snaps_to_the_origin_without_a_distance_or_waypoints_is_refused(engine_over):
    """出発地のすぐ近く（同じ道路のノードへ寄る所）に置いた目的地へ距離を決めずに向かう要求は、出発地のすぐ隣で折り返す
    だけの経路や空の経路を出さずに断る（理由の文は`test_route_generator.py`）。"""
    generator = engine_over(grid_network())
    near_origin = Coordinates(latitude=at(CENTER).latitude + LAT_STEP / 30, longitude=at(CENTER).longitude)

    assert await generator.generate_via_waypoints(
        at(CENTER), [], destination=near_origin, max_routes=3, start_time=DEPARTURE) == []
    assert generator.last_no_candidates_reason is not None


def _spliced_at_a_shared_node(candidates) -> list[str]:
    """候補の1本の前半と、別の1本の後半を、両方が途中で通るノードでつないだ経路（どちらの候補とも違うもの）。"""
    for first in candidates:
        for second in candidates:
            for i, node in enumerate(first.node_ids[1:-1], start=1):
                for j, other in enumerate(second.node_ids[1:-1], start=1):
                    edges = [*first.edge_ids[:i], *second.edge_ids[j:]]
                    if node == other and edges not in ([*c.edge_ids] for c in candidates):
                        return edges
    raise AssertionError("途中で同じノードを通る候補の組が無い")


async def test_loops_spliced_together_are_evaluated_as_one_route_back_to_the_origin(engine_over):
    """周回の候補どうしを途中で乗り換えた経路も、出発地から出て出発地へ戻る1本として、送ったとおりに評価する。"""
    generator = engine_over(grid_network())
    candidates = await generator.generate_loops(
        at(CENTER), 4.0, 1.5, max_routes=5, start_time=DEPARTURE, points=NO_POINTS)
    edges = _spliced_at_a_shared_node(candidates)

    (spliced,) = await generator.generate_spliced_route(at(CENTER), None, tuple(edges), start_time=DEPARTURE)

    assert spliced.edge_ids == edges
    assert_connected(spliced, CENTER, CENTER)


@pytest.mark.parametrize(
    ("network", "origin", "waypoints"),
    [
        pytest.param(LATTICE, lattice_node(1, 1), [lattice_node(1, 4), lattice_node(4, 4)], id="経由地2つ"),
        # Wだけを置いた周回は逆に回って出る（上のテスト）ので、逆回りの経由地の道のりを見る。
        pytest.param(RING, 1, [3], id="逆に回った経由地1つ"),
    ],
)
async def test_each_placed_point_is_listed_at_the_distance_where_the_route_passes_it(
    engine_over, network, origin, waypoints,
):
    """経由地ごとの道のりは、置いた順に、経路がその経由地を通るまでの道の長さ——違う距離だと、道のりのグラフの
    経由地の印が地図のピンと別の所に出る。"""
    generator = engine_over(network, avoid_weight=1.0)

    candidates = await generator.generate_via_waypoints(
        node_point(network, origin), [node_point(network, point) for point in waypoints], destination=None,
        max_routes=3, start_time=DEPARTURE)

    assert candidates
    for candidate in candidates:
        osm_ids = nodes_of(candidate)
        road_km = [0.0, *accumulate(
            haversine_distance_km(node_point(network, a), node_point(network, b)) for a, b in zip(osm_ids, osm_ids[1:])
        )]
        expected, position = [], 0
        for point in waypoints:
            position = osm_ids.index(point, position)
            expected.append(road_km[position])
        assert candidate.waypoint_distances_km == pytest.approx(expected, abs=0.02)


async def test_a_destination_on_an_isolated_road_is_moved_to_the_nearest_reachable_node(engine_over):
    """指した先が本線とつながらない小塊だと、そこへ着く経路は無い。すぐ近くの本線へ移して、移したことを返す。"""
    generator = engine_over(grid_network(island=True))

    candidates = await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(91), max_routes=3, start_time=DEPARTURE)

    assert candidates
    for candidate in candidates:
        assert_connected(candidate, SOUTH_WEST, NORTH_EAST)
    assert generator.last_destination_correction == at(NORTH_EAST)


def _stuck_by_north_east(east_deg: float) -> tuple[RoadNetwork, Coordinates]:
    """格子と、北東の角から`east_deg`だけ東の点。その点の一番近い道は、格子とつながらない道。"""
    end = (COORDINATES[NORTH_EAST][0], COORDINATES[NORTH_EAST][1] + east_deg)
    ways = {**WAYS, ISLAND_WAY: (90, 91)}
    coordinates = {**COORDINATES, 90: (end[0], end[1] - 0.004), 91: end}
    return road_network(ways, coordinates), Coordinates(latitude=end[0], longitude=end[1])


@pytest.mark.parametrize("placed", ["origin_of_distance_loop", "waypoint"])
async def test_a_point_whose_nearest_road_cannot_be_left_is_moved_to_the_nearest_road_that_can(engine_over, placed):
    """出発地・経由地の一番近い道から格子へ出入りできないと、そこを通る経路は無い。すぐ近くの出入りできる道へ寄せて出す。"""
    network, point = _stuck_by_north_east(0.008)
    generator = engine_over(network)

    if placed == "origin_of_distance_loop":
        candidates = await generator.generate_loops(point, 6.0, 1.5, max_routes=3, start_time=DEPARTURE, points=NO_POINTS)  # 角から回れる長さ
    else:
        candidates = await generator.generate_via_waypoints(
            at(SOUTH_WEST), [point], destination=None, max_routes=3, start_time=DEPARTURE)

    assert candidates
    start = SOUTH_WEST if placed == "waypoint" else NORTH_EAST
    for candidate in candidates:
        assert_connected(candidate, start, start)
        assert node_key(NORTH_EAST) in candidate.node_ids


@pytest.mark.parametrize(("nearest", "placed"), [
    ("cannot_be_left", "origin"),
    # 寄せる判断は1つで、置いた点の種類ごとには寄せていることを1行で見る。
    ("far", "origin"),
    ("far", "waypoint"),
    ("far", "destination"),
])
async def test_a_point_with_no_road_it_can_ride_nearby_is_refused(engine_over, nearest, placed):
    """出入りできる道が近くに無いなら、指した覚えのない遠くの道へ黙って寄せない。一番近い道が出入りできない
    （`cannot_be_left`）ときも、一番近い道が格子の角で、それ自体が遠い（`far`。川・山の中を指した）ときも同じ。"""
    if nearest == "cannot_be_left":
        network, point = _stuck_by_north_east(0.03)  # 北東の角から約2.7km
    else:
        network = grid_network()
        point = Coordinates(latitude=COORDINATES[NORTH_EAST][0], longitude=COORDINATES[NORTH_EAST][1] + 0.015)  # 約1.4km
    generator = engine_over(network)

    if placed == "origin":
        candidates = await generator.generate_loops(point, 6.0, 1.5, max_routes=3, start_time=DEPARTURE, points=NO_POINTS)  # 角から回れる長さ
    elif placed == "waypoint":
        candidates = await generator.generate_via_waypoints(
            at(SOUTH_WEST), [point], destination=None, max_routes=3, start_time=DEPARTURE)
    else:
        candidates = await generator.generate_via_waypoints(
            at(SOUTH_WEST), [], destination=point, max_routes=3, start_time=DEPARTURE)

    assert candidates == []
    assert generator.last_no_candidates_reason


# --- 区間の表示 ---


DEPARTURE = datetime(2026, 9, 22, 8, 10, tzinfo=JST)


async def test_segment_arrival_times_run_from_the_departure_within_the_duration(engine_over):
    """到達予想は探索と同じ時計で積む。最初の区間は出発時刻に始まり、どの区間も所要時間の内に入る。"""
    generator = engine_over(grid_network())

    (candidate, *_) = await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=1, start_time=DEPARTURE)

    arrivals = [datetime.fromisoformat(s.estimated_arrival_time) for s in candidate.segments]
    assert arrivals[0] == DEPARTURE
    assert arrivals == sorted(set(arrivals))
    assert arrivals[-1] < DEPARTURE + timedelta(seconds=candidate.estimated_duration_seconds)


async def test_turns_are_listed_where_the_route_changes_direction_at_a_branch(engine_over):
    """曲がる所は、経路が分かれ道（3本以上の道が集まる点）で向きを変える点にだけ、経路の順に並ぶ。左右は進む向きの
    変わり方で決まり、距離は始点からの道のり。分かれ道の無い角（格子の四隅）で曲がっても案内しない——案内すると、道なりに
    進むだけの所で「曲がる」と言ってしまう。"""
    generator = engine_over(grid_network())
    degree = Counter(node for ends in WAYS.values() for node in ends)

    candidates = await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=3, start_time=DEPARTURE)

    assert candidates
    for candidate in candidates:
        nodes = nodes_of(candidate)
        expected = []
        for k in range(1, len(nodes) - 1):
            (a_lat, a_lon), (b_lat, b_lon), (c_lat, c_lon) = (COORDINATES[n] for n in nodes[k - 1:k + 2])
            cross = (b_lon - a_lon) * (c_lat - b_lat) - (b_lat - a_lat) * (c_lon - b_lon)
            if cross == 0:
                continue
            if degree[nodes[k]] < 3:
                continue
            along_km = sum(haversine_distance_km(at(a), at(b)) for a, b in zip(nodes[:k], nodes[1:k + 1]))
            expected.append((COORDINATES[nodes[k]], "left" if cross > 0 else "right", along_km))
        turns = [((turn.latitude, turn.longitude), turn.direction, turn.distance_km) for turn in candidate.turns]
        assert [(point, direction) for point, direction, _ in turns] == [
            (pytest.approx(point), direction) for point, direction, _ in expected
        ]
        for (_, _, km), (_, _, along_km) in zip(turns, expected):
            assert km == pytest.approx(along_km, abs=0.02)


async def test_a_segment_and_a_turn_sit_where_the_segments_before_them_add_up_to(engine_over):
    """区間の始まりの道のり（`cumulative_distance_km`）と曲がる所の道のりは、手前の区間の`distance_km`を始点から足した値に
    載る——別の積み方だと、同じ地点の距離が「km地点」・道のりのグラフ・曲がる所までの残りで食い違う。格子の1辺は区間の
    まとめる幅より長いので、区間は辺ごとに分かれ、曲がる所はどれかの区間の始まりに来る。"""
    generator = engine_over(grid_network())

    candidates = await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=3, start_time=DEPARTURE)

    assert any(candidate.turns for candidate in candidates)
    for candidate in candidates:
        added_up = list(accumulate((segment.distance_km for segment in candidate.segments), initial=0.0))
        assert [segment.cumulative_distance_km for segment in candidate.segments] == pytest.approx(added_up[:-1])
        segment_at = {(s.start_latitude, s.start_longitude): i for i, s in enumerate(candidate.segments)}
        for turn in candidate.turns:
            assert turn.distance_km == pytest.approx(added_up[segment_at[(turn.latitude, turn.longitude)]])


async def test_the_distance_along_the_route_is_the_length_of_the_roads_behind(engine_over):
    """区間の始まりの道のりは、手前の道の長さ——違う長さだと「km地点」が地図の上の場所とずれる。道の長さの換算の誤りは
    約1kmの道では応答の桁の丸めに埋もれるので、約20kmの道を通る。"""
    start, far, east = (BASE_LAT, BASE_LON), (BASE_LAT + 20 * LAT_STEP, BASE_LON), (BASE_LAT + 20 * LAT_STEP, BASE_LON + LON_STEP)
    generator = engine_over(road_network({1: (1, 2), 2: (2, 3)}, {1: start, 2: far, 3: east}))

    (candidate, *_) = await generator.generate_via_waypoints(
        Coordinates(latitude=start[0], longitude=start[1]), [],
        destination=Coordinates(latitude=east[0], longitude=east[1]), max_routes=1, start_time=DEPARTURE)

    beyond = next(s for s in candidate.segments if (s.start_latitude, s.start_longitude) == pytest.approx(far))
    road_km = haversine_distance_km(Coordinates(latitude=start[0], longitude=start[1]), Coordinates(latitude=far[0], longitude=far[1]))
    assert beyond.cumulative_distance_km == pytest.approx(road_km, abs=0.005)


async def test_a_point_near_the_route_is_listed_at_the_distance_where_the_route_passes_it(engine_over):
    """近くの点は、通る区間の始まりの道のりに区間の上の位置を足した距離に、種類と値つきで載る——道のりのグラフの印が
    地図の上の点と同じ所に出る。"""
    start, far, east = (BASE_LAT, BASE_LON), (BASE_LAT + 2 * LAT_STEP, BASE_LON), (BASE_LAT + 2 * LAT_STEP, BASE_LON + LON_STEP)
    toilets = RoutePointHit(layer="supply_poi", point_key="n1", merge_group=None, properties={"kind": "toilets"},
                            fraction=0.5, distance_m=10.0)
    generator = engine_over(road_network({1: (1, 2), 2: (2, 3)}, {1: start, 2: far, 3: east}),
                            side_points={(2, 0): [toilets]})

    (candidate, *_) = await generator.generate_via_waypoints(
        Coordinates(latitude=start[0], longitude=start[1]), [],
        destination=Coordinates(latitude=east[0], longitude=east[1]), max_routes=1, start_time=DEPARTURE)

    beyond = next(s for s in candidate.segments if (s.start_latitude, s.start_longitude) == pytest.approx(far))
    assert [(point.layer, point.properties) for point in candidate.points] == [("supply_poi", {"kind": "toilets"})]
    # 応答の道のりはどれも0.01km単位に丸めて出るので、丸めの幅で比べる。
    assert candidate.points[0].distance_km == pytest.approx(beyond.cumulative_distance_km + beyond.distance_km / 2, abs=0.01)


async def test_each_segment_starts_and_ends_at_the_elevation_of_its_road_in_the_direction_ridden(engine_over):
    """画面は区間の端の標高を距離に沿って結んで描く。逆向きに走る道で端を入れ替えないと、登りが下りに描かれる。
    南東→南西の最速は道101（標高が無い）と、西→東に引いた道100を東→西へ走る区間。"""
    generator = engine_over(grid_network(elevation_of={100: (10.0, 12.04)}))

    candidates = await generator.generate_via_waypoints(
        at(SOUTH_EAST), [], destination=at(SOUTH_WEST), max_routes=3, start_time=DEPARTURE)

    first, second = fastest_of(candidates).segments
    assert [[(e.start_elevation_m, e.end_elevation_m) for e in s.elevations] for s in (first, second)] == [
        [(None, None)], [(12.0, 10.0)],
    ]


async def test_each_segment_carries_its_road_classes(engine_over):
    """道のりのグラフは区間の区分を、地図の線の層ごとに層の値で受ける（呼び名と色は軸カタログの区分から引く）。どの区分にも入らない
    道は値なし。緑と水は、区間の最も多いクラスで塗る（同率は宣言の並びの先）。
    南西→南東の最速は、林と水辺が同じ割合の生活道路の道100と、土地被覆の値の無いトンネルの道101。"""
    landcover = {100: {"built_percent": 20.0, "trees_percent": 40.0, "water_percent": 40.0}}
    definitions = road_classes(
        {
            "kind": classification({"local": [fact_is(HIGHWAY, "residential")]}),
            "tunnel": classification({"yes": [fact_is(TUNNEL, TRUE_FACT_VALUE)]}),
        },
        map_layers={"kind": map_layer(0), "tunnel": map_layer(1)},
    )
    generator = engine_over(grid_network(tunnel_ways={101}, landcover_of=landcover))

    with replaced_road_classes(definitions):
        candidates = await generator.generate_via_waypoints(
            at(SOUTH_WEST), [], destination=at(SOUTH_EAST), max_routes=3, start_time=DEPARTURE)

    fastest = fastest_of(candidates)
    assert ways_of(fastest) == [100, 101]
    first, second = fastest.segments
    assert [
        {key: [(s.distance_km, s.value) for s in stretches] for key, stretches in segment.road_classes.items()}
        for segment in fastest.segments
    ] == [
        {"kind": [(first.distance_km, "local")], "tunnel": [(first.distance_km, None)],
         "landcover": [(first.distance_km, "trees_percent")]},
        {"kind": [(second.distance_km, "local")], "tunnel": [(second.distance_km, "yes")],
         "landcover": [(second.distance_km, None)]},
    ]


def _slope_axis(*, is_published: bool) -> AxisDefinition:
    """勾配の符号付きの値を地図が塗る軸（本番の勾配の軸と同じく、勾配の絶対値を読む折れ線）。"""
    return AxisDefinition(
        axis_id="slope", label="勾配", default_weight=0.0, is_published=is_published,
        shape=BreakpointLinearShape(
            terms=[MaterialTerm(material=GRADIENT_PERCENT)], preprocess="abs", breakpoints=[(0.0, 0.0), (10.0, 100.0)],
        ),
    )


@pytest.mark.parametrize(("is_published", "carried"), [(True, True), (False, False)])
async def test_a_published_slope_axis_carries_its_grade_on_every_segment_even_with_no_weight(
    engine_over, is_published, carried,
):
    """地図のレンズはルートを作ったあとにも勾配へ切り替わり、切り替えでは作り直さない。重み0の勾配の軸でも
    区間が勾配の値を持たないと、あとから勾配のレンズにしたとき全区間が「データなし」になる。下書きの軸はレンズに出ない。"""
    surveyed = grid_network(elevation_of={way: (0.0, 0.0) for way in WAYS})
    with replaced_axis_definitions({**AXIS_DEFINITIONS, "slope": _slope_axis(is_published=is_published)}):
        candidates = await engine_over(surveyed).generate_via_waypoints(
            at(SOUTH_WEST), [], destination=at(SOUTH_EAST), max_routes=1, start_time=DEPARTURE)

    assert [GRADIENT_PERCENT in segment.material_values for segment in candidates[0].segments] == [carried, carried]


async def test_the_share_of_the_route_timed_without_data_is_reported(engine_over):
    """勾配の値が無い道は平地として所要時間を出す。その距離の割合を候補が持ち、画面が利用者へ知らせる。
    南西→南東の最速は同じ長さの2本の道で、1本目だけ値が無い。"""
    generator = engine_over(grid_network(no_gradient_ways={100}))

    candidates = await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(SOUTH_EAST), max_routes=3, start_time=DEPARTURE)

    fastest = fastest_of(candidates)
    assert ways_of(fastest)[0] == 100
    assert fastest.missing_travel_data_share == pytest.approx(0.5, abs=0.01)
    complete = await engine_over(grid_network()).generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(SOUTH_EAST), max_routes=3, start_time=DEPARTURE)
    assert fastest_of(complete).missing_travel_data_share == 0.0


def _rain_axis(axis_id: str, *materials: str) -> AxisDefinition:
    terms = [MaterialTerm(material=rain_window_material_id(3)), *(MaterialTerm(material=m) for m in materials)]
    return AxisDefinition(
        axis_id=axis_id, label="雨", default_weight=0.0, is_published=True,
        shape=BreakpointLinearShape(terms=terms, breakpoints=[(0.0, 0.0), (10.0, 100.0)]),
    )


#: 雨の材料だけを読む軸と、雨と道の材料（避けたい材料）を足して読む軸。
RAIN_AXES = {"rain": _rain_axis("rain"), "rain_and_bad": _rain_axis("rain_and_bad", BAD_MATERIAL)}

#: 南の道の西半分（道100、中点139.6055E）の近くと、東半分（道101、中点139.6165E）の近くの雨量計。
RAIN_GAUGES = {
    "west": {"lat": [35, 36.0], "lon": [139, 36.0], "kjName": "西"},
    "east": {"lat": [35, 36.0], "lon": [139, 37.32], "kjName": "東"},
}


async def test_each_segment_is_scored_with_the_rain_at_the_gauge_nearest_its_midpoint(engine_over, fake_redis):
    """雨の材料は区間の中点に最も近い雨量計の今の観測で、道の材料と同じく区間の得点とルートの生値（mm）に載る
    ——雨と道の材料を1つの軸で足すこともできる。南西→南東の最速は道100（西の雨量計）と道101（東の雨量計）で、
    西では1時間1.0mmの雨が続き、東は降っていない。"""
    await rain_history_fake.observe(RAIN_GAUGES, {"west": 1.0, "east": 0.0})

    with replaced_axis_definitions({**AXIS_DEFINITIONS, **RAIN_AXES}):
        candidates = await engine_over(grid_network(bad_ways={101})).generate_via_waypoints(
            at(SOUTH_WEST), [], destination=at(SOUTH_EAST), max_routes=3, start_time=DEPARTURE)

    fastest = fastest_of(candidates)
    assert ways_of(fastest) == [100, 101]
    # 3時間の雨量は1時間1.0mmの3本ぶん。道101の避けたい材料1は、雨の0mmに足されて10点になる。
    assert [segment.axis_difficulties["rain"] for segment in fastest.segments] == [30.0, 0.0]
    assert [segment.axis_difficulties["rain_and_bad"] for segment in fastest.segments] == [30.0, 10.0]
    assert fastest.axis_raw_values["rain"] == pytest.approx(
        3.0 * fastest.segments[0].distance_km / sum(segment.distance_km for segment in fastest.segments), rel=1e-3)


#: 信号の密度（回/km）を、0から始まる直線（11回/kmで100点、その先は100点）で点数にする軸（停止密度の軸の形）。
STOP_AXIS = AxisDefinition(
    axis_id="stops", label="停止", default_weight=0.0, is_published=True,
    shape=BreakpointLinearShape(
        terms=[MaterialTerm(material=stop_count_material_ids()[0])], breakpoints=[(0.0, 0.0), (11.0, 100.0)],
    ),
)


async def test_a_route_scores_a_density_axis_from_its_mean_count_rather_than_the_mean_of_segment_scores(engine_over):
    """1kmあたりの回数で測る軸は、ルートの値を回数の距離平均から点数にする。南西→南東の最速は同じ長さの道100（12回/km）と
    道101（0回/km）で、区間の点数（頭打ちの100点と0点）の平均は50点だが、回数の平均（6回/km）の点数は54.5点。
    待ちの秒で遠回りが速くならないよう、南西と南東から北へ出る道は走れない道にする。"""
    network = grid_network(stop_density_of={100: 12.0}, motorway_ways={200, 202})
    with replaced_axis_definitions({**AXIS_DEFINITIONS, "stops": STOP_AXIS}):
        candidates = await engine_over(network).generate_via_waypoints(
            at(SOUTH_WEST), [], destination=at(SOUTH_EAST), max_routes=3, start_time=DEPARTURE)

    fastest = fastest_of(candidates)
    assert ways_of(fastest) == [100, 101]
    assert [segment.axis_difficulties["stops"] for segment in fastest.segments] == [100.0, 0.0]
    assert fastest.axis_difficulties["stops"] == 54.5


async def test_without_an_observation_history_only_the_rain_axis_has_no_data(engine_over, fake_redis):
    """履歴が無い（バッチがまだ・Redisが不通）ときもルートは出て、雨を読む軸だけが「データなし」になる。"""

    with replaced_axis_definitions({**AXIS_DEFINITIONS, **RAIN_AXES}):
        candidates = await engine_over(grid_network()).generate_via_waypoints(
            at(SOUTH_WEST), [], destination=at(SOUTH_EAST), max_routes=3, start_time=DEPARTURE)

    fastest = fastest_of(candidates)
    assert all("rain" not in segment.axis_difficulties for segment in fastest.segments)
    assert all(segment.axis_difficulties[AVOID_AXIS] == 0.0 for segment in fastest.segments)


def _wind(times: list[datetime], speed_by_point: list[float]) -> WindForecastSeries:
    """格子の角4点（南西・南東・北西・北東）に置いた時別の風。風速は時刻によらず点ごとに一定。"""
    lattice = MsmBlock(
            grid=MsmGrid(lat_min=BASE_LAT, lon_min=BASE_LON, d_lat=2 * LAT_STEP, d_lon=2 * LON_STEP, n_lat=2, n_lon=2), row0=0, col0=0, rows=2, cols=2,
        )
    speed = np.repeat(np.array(speed_by_point, dtype=float)[:, None], len(times), axis=1)
    return WindForecastSeries(times=times, speed_ms=speed, direction_deg=np.zeros_like(speed), lattice=lattice)


HOURS_OF_THE_DAY = [datetime(2026, 9, 22, h) for h in range(24)]


async def test_segment_wind_is_the_forecast_for_the_local_time_of_passing(engine_over):
    """予報の時刻は日本時間。出発時刻を別のタイムゾーンで渡されても、通る時刻の予報を読む（ずれると9時間違う風になる）。"""
    generator = engine_over(grid_network(), wind=_wind(HOURS_OF_THE_DAY, [3.0, 3.0, 3.0, 3.0]))

    (candidate, *_) = await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=1,
        start_time=DEPARTURE.astimezone(timezone.utc))

    assert {s.wind.forecast_at for s in candidate.segments} == {"2026-09-22T08:00"}


async def test_a_route_timed_without_the_wind_forecast_says_so(engine_over):
    """風の予報が読めないときは無風として所要時間を出す。出したことを候補が持ち、画面が利用者へ知らせる。"""
    without = await engine_over(grid_network()).generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=1, start_time=DEPARTURE)
    with_wind = await engine_over(grid_network(), wind=_wind(HOURS_OF_THE_DAY, [3.0] * 4)).generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=1, start_time=DEPARTURE)

    assert all(c.wind_unavailable for c in without)
    assert not any(c.wind_unavailable for c in with_wind)
