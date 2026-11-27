"""生成した候補が運ぶ区間の表示（到達予想・曲がる所・道のり・標高・道の区分）と費用の内訳を、公開の入口（`RouteGenerator`）だけから確かめる。

道路網と、それをエンジンへ渡す道具は`tests/route_world.py`が持つ。

ここで見ないもの:
- どの経路を選ぶか（費用の効き・一方通行・周回・経由地と目的地の扱い） → `test_route_generation_behavior.py`
"""

from collections import Counter
from dataclasses import replace
from datetime import datetime, timedelta
from functools import partial

import numpy as np
import pytest

from app.domain.cost_axes import EFFORT_AXES
from app.domain.geo import bearing_between, haversine_distance_km
from app.domain.gradient import GRADIENT_VALUE_DECIMALS
from app.domain.landcover import LANDCOVER_CLASSES
from app.domain.material_catalog import MATERIAL_CATALOG
from app.domain.road_classes import TRUE_FACT_VALUE, AvoidanceClassification
from app.domain.route import AxisFact, Coordinates
from app.domain.tuning import BASE_CRR_ID
from tests.cost_axes_fixture import BAD_AXIS, cost_axes, cost_axes_declared
from tests.road_class_fixture import classification, fact_is, map_layer, replaced_road_classes, road_classes
from tests.route_world import (
    BAD_MATERIAL,
    BASE_LAT,
    BASE_LON,
    CALM,
    CENTER,
    COORDINATES,
    DEPARTURE,
    HIGHWAY,
    LAT_STEP,
    LON_STEP,
    NODE_OF,
    NORTH_EAST,
    SOUTH_EAST,
    SOUTH_WEST,
    TUNNEL,
    WAYS,
    at,
    fastest_of,
    generator_for,
    grid_network,
    node_point,
    nodes_of,
    road_network,
    ways_of,
)
from tests.tuning_fixture import TUNING


@pytest.fixture
def engine_over(road_network_root):
    """道路網から、本物のエンジンの上に戦略層（`RouteGenerator`）を組む。"""
    return partial(generator_for, road_network_root)


@pytest.mark.parametrize(
    ("latest_run_end", "expected"), [(datetime(2026, 9, 22, 9), False), (datetime(2026, 9, 22, 8), True)],
    ids=["最新のrunの中で着く", "最新のrunの終わりから先の風を引く"],
)
async def test_a_route_ridden_on_the_wind_of_a_previous_run_is_marked(engine_over, latest_run_end, expected):
    """配信元が新しいrunを出さない間も前に出たrunの風で作り、画面が但し書きを出せるよう候補に印を付ける。08:10に出て
    数分で着くので、08:00の風を引く。"""
    candidates = (await engine_over(grid_network(), wind=replace(CALM, latest_run_end=latest_run_end)).generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(SOUTH_EAST), max_routes=3, start_time=DEPARTURE)).candidates

    assert candidates
    assert {candidate.wind_previous_run_from for candidate in candidates} == {latest_run_end if expected else None}


async def test_the_route_rides_the_forecast_wind_lowered_to_the_rider_by_the_roughness_around_the_road(engine_over):
    """予報は地上10mの風で、乗り手の高さでは道の周りが粗いほど弱い。北へ1km走る道の向かい風の事実は、予報の北風6m/sに
    周りの土地被覆の粗度長の対数則の倍率（森0.23・水辺0.80）を掛けた値で、同じ道・同じ予報でも森の中のほうが速く着く。"""
    wind = replace(CALM, speed_ms=np.full_like(CALM.speed_ms, 6.0))

    async def ride_north(cover: str):
        landcover = {cls.percent_field: 100.0 if cls.percent_field == cover else 0.0 for cls in LANDCOVER_CLASSES}
        network = grid_network(landcover_of=dict.fromkeys(WAYS, landcover))
        candidates = (await engine_over(network, wind=wind).generate_via_waypoints(
            at(NODE_OF[0, 1]), [], destination=at(CENTER), max_routes=1, start_time=DEPARTURE)).candidates
        fastest = fastest_of(candidates)
        assert ways_of(fastest) == [201]
        return fastest

    forest, waterside = await ride_north("trees_percent"), await ride_north("water_percent")

    assert forest.facts.axes["headwind"].value == pytest.approx(6.0 * 0.23, abs=0.06)
    assert waterside.facts.axes["headwind"].value == pytest.approx(6.0 * 0.80, abs=0.06)
    assert forest.estimated_duration_seconds < waterside.estimated_duration_seconds


async def test_segment_arrival_times_run_from_the_departure_within_the_duration(engine_over):
    """到達予想は探索と同じ時計で積む。最初の区間は出発時刻に始まり、どの区間も所要時間の内に入る。"""
    generator = engine_over(grid_network())

    (candidate, *_) = (await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=1, start_time=DEPARTURE)).candidates

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

    candidates = (await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=3, start_time=DEPARTURE)).candidates

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


@pytest.mark.parametrize("oneway_ways", [(), (3,)], ids=["two_way", "one_way_from_the_west"])
async def test_a_turn_lists_the_other_roads_of_its_crossing_by_the_direction_they_leave_it(engine_over, oneway_ways):
    """曲がる所は、その交差点に集まる道のうち経路が入る道・出る道でないものを、交差点から離れる向きで持つ——画面はこれを
    曲がる所の絵に描き、どの道へ入るかを入らない道と見比べさせる。向こうから来るだけの一方通行（西から交差点へ入る道）も、
    交差点に見える道なので入る。南から来て東へ曲がる十字路で、残りは北西寄りの道と西の道。"""
    south, crossing, east = (BASE_LAT, BASE_LON), (BASE_LAT + LAT_STEP, BASE_LON), (BASE_LAT + LAT_STEP, BASE_LON + LON_STEP)
    west, north_west = (BASE_LAT + LAT_STEP, BASE_LON - LON_STEP), (BASE_LAT + 2 * LAT_STEP, BASE_LON - LON_STEP / 2)
    points = {1: south, 2: crossing, 3: east, 4: west, 5: north_west}
    ways = {1: (1, 2), 2: (2, 3), 3: (4, 2), 4: (2, 5)}
    generator = engine_over(road_network(ways, points, oneway_ways=oneway_ways))

    (candidate, *_) = (await generator.generate_via_waypoints(
        Coordinates(latitude=south[0], longitude=south[1]), [],
        destination=Coordinates(latitude=east[0], longitude=east[1]), max_routes=1, start_time=DEPARTURE)).candidates

    at_crossing = Coordinates(latitude=crossing[0], longitude=crossing[1])
    away = sorted(round(bearing_between(at_crossing, Coordinates(latitude=p[0], longitude=p[1]))) for p in (west, north_west))
    assert [((turn.latitude, turn.longitude), turn.direction, turn.other_road_bearings_deg) for turn in candidate.turns] == [
        (pytest.approx(crossing), "right", away)]


async def test_a_segment_and_a_turn_sit_where_the_line_points_say(engine_over):
    """曲がる所の道のりは、その地点の線の点の道のり（`point_distances_m`）に載る——別の物差しだと、同じ地点の距離が
    「km地点」・道のりのグラフ・曲がる所までの残りで食い違う。格子の1辺は区間のまとめる幅より長いので、区間は辺ごとに分かれ、
    曲がる所は線のどれかの点に来る。線の終わりの道のりは経路の全長になる。"""
    generator = engine_over(grid_network())

    candidates = (await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=3, start_time=DEPARTURE)).candidates

    assert any(candidate.turns for candidate in candidates)
    for candidate in candidates:
        distances = candidate.point_distances_m
        assert len(distances) == len(candidate.geometry["coordinates"])
        assert distances[-1] / 1000 == pytest.approx(candidate.distance_km, abs=0.02)
        point_at = {tuple(point[:2]): i for i, point in enumerate(candidate.geometry["coordinates"])}
        for turn in candidate.turns:
            assert turn.distance_km == pytest.approx(distances[point_at[(turn.longitude, turn.latitude)]] / 1000)


async def test_the_distance_along_the_route_is_the_length_of_the_roads_behind(engine_over):
    """区間の始まりの道のりは、手前の道の長さ——違う長さだと「km地点」が地図の上の場所とずれる。道の長さの換算の誤りは
    約1kmの道では応答の桁の丸めに埋もれるので、約20kmの道を通る。"""
    start, far, east = (BASE_LAT, BASE_LON), (BASE_LAT + 20 * LAT_STEP, BASE_LON), (BASE_LAT + 20 * LAT_STEP, BASE_LON + LON_STEP)
    generator = engine_over(road_network({1: (1, 2), 2: (2, 3)}, {1: start, 2: far, 3: east}))

    (candidate, *_) = (await generator.generate_via_waypoints(
        Coordinates(latitude=start[0], longitude=start[1]), [],
        destination=Coordinates(latitude=east[0], longitude=east[1]), max_routes=1, start_time=DEPARTURE)).candidates

    beyond = next(s for s in candidate.segments if (s.start_latitude, s.start_longitude) == pytest.approx(far))
    road_km = haversine_distance_km(Coordinates(latitude=start[0], longitude=start[1]), Coordinates(latitude=far[0], longitude=far[1]))
    assert beyond.point_distances_m[0] / 1000 == pytest.approx(road_km, abs=0.005)


async def test_each_segment_line_carries_the_elevation_of_its_road_in_the_direction_ridden(engine_over):
    """画面は区間の線の点の標高（RFC 7946 の3つ目）を距離に沿って結んで描き、区間の小窓に平均勾配を出す。逆向きに走る道で
    標高の並びと勾配の符号を入れ替えないと、登りが下りに描かれる。南東→南西の最速は道101（標高が無いので点は標高を持たない）と、
    西→東に引いた道100を東→西へ走る区間。"""
    generator = engine_over(grid_network(elevation_of={100: (10.0, 12.0)}, no_gradient_ways={101}))

    candidates = (await generator.generate_via_waypoints(
        at(SOUTH_EAST), [], destination=at(SOUTH_WEST), max_routes=3, start_time=DEPARTURE)).candidates

    first, second = fastest_of(candidates).segments
    # 区間の境目の点は次の道（標高のある道）の始まりと同じ点なので、標高を持つ。
    assert all(len(point) == 2 for point in first.geometry["coordinates"][:-1])
    assert (second.geometry["coordinates"][0][2], second.geometry["coordinates"][-1][2]) == (12.0, 10.0)
    (east_lon, east_lat, _), (west_lon, west_lat, _) = second.geometry["coordinates"][0], second.geometry["coordinates"][-1]
    road_m = haversine_distance_km(Coordinates(latitude=east_lat, longitude=east_lon),
                                   Coordinates(latitude=west_lat, longitude=west_lon)) * 1000
    assert first.average_gradient_percent is None
    assert second.average_gradient_percent == round(-2.0 / road_m * 100, GRADIENT_VALUE_DECIMALS)


async def test_each_segment_carries_its_road_classes(engine_over):
    """道のりのグラフは区間の区分を、地図の線の層ごとに層の値で受ける（呼び名と色は画面の設定の区分から引く）。どの区分にも入らない
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
        candidates = (await generator.generate_via_waypoints(
            at(SOUTH_WEST), [], destination=at(SOUTH_EAST), max_routes=3, start_time=DEPARTURE)).candidates

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


#: どの道も土地被覆の割合を持つ（試験の道路網の既定は持たない）。
_COVERED = {way: {c.percent_field: 100.0 if c.percent_field == "built_percent" else 0.0 for c in LANDCOVER_CLASSES}
            for way in WAYS}


@pytest.mark.parametrize("missing", [
    # 勾配の値が無い道は、標高の欠けを埋めて所要時間を出す。
    {"no_gradient_ways": {100}, "landcover_of": _COVERED},
    # 土地被覆の割合が無い道は、割合を埋めて風の高さの倍率を求める。
    {"landcover_of": {way: cover for way, cover in _COVERED.items() if way != 100}},
])
async def test_the_share_of_the_route_timed_without_data_is_reported(engine_over, missing):
    """値が欠けて埋めて所要時間を出した道の距離の割合を候補が持ち、画面が利用者へ知らせる。南西→南東の最速は同じ長さの
    2本の道で、1本目だけ値が無い。"""
    generator = engine_over(grid_network(**missing))

    candidates = (await generator.generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(SOUTH_EAST), max_routes=3, start_time=DEPARTURE)).candidates

    fastest = fastest_of(candidates)
    assert ways_of(fastest)[0] == 100
    assert fastest.missing_travel_data_share == pytest.approx(0.5, abs=0.01)
    complete = (await engine_over(grid_network(landcover_of=_COVERED)).generate_via_waypoints(
        at(SOUTH_WEST), [], destination=at(SOUTH_EAST), max_routes=3, start_time=DEPARTURE)).candidates
    assert fastest_of(complete).missing_travel_data_share == 0.0


async def test_the_duration_and_the_penalty_of_each_axis_and_of_the_preferred_and_avoided_roads_add_up_to_the_cost(
    engine_over,
):
    """候補の費用（並べ方の値）は、所要時間と、軸ごとの代償の秒と、好む道で下げた秒と、なるべく避ける道で上乗せした秒の和に
    なる。合わないと、画面の内訳を見ても候補がなぜその順に並んだのかが分からない。道100だけが振動の材料を持ってなるべく避け、
    道101を好む。軸ごとの事実は、その軸の秒の元を1つ出す。"""
    definitions = road_classes(
        {
            "kind": classification({"local": [fact_is(HIGHWAY, "residential")]}),
            "tunnel": classification({"yes": [fact_is(TUNNEL, TRUE_FACT_VALUE)]}),
            "bad": classification({"yes": [fact_is(BAD_MATERIAL, TRUE_FACT_VALUE)]}),
        },
        map_layers={"kind": map_layer(0), "tunnel": map_layer(1), "bad": map_layer(2)},
        avoidance_classifications={
            "tunnel": AvoidanceClassification(overrides={}), "bad": AvoidanceClassification(overrides={}),
        },
        rolling_resistance_classification="kind",
        rolling_resistance_classes={"kind": {"local": BASE_CRR_ID}},
    )
    with replaced_road_classes(definitions), cost_axes_declared(cost_axes(BAD_MATERIAL)):
        candidates = (await engine_over(
            grid_network(bad_ways={100}, stop_density_of={101: 3.0}, tunnel_ways={101}),
            road_avoidance={"tunnel.yes": "prefer", "bad.yes": "avoid"},
        ).generate_via_waypoints(at(SOUTH_WEST), [], destination=at(SOUTH_EAST), max_routes=3, start_time=DEPARTURE)).candidates

    assert candidates
    for candidate in candidates:
        penalty = candidate.penalty
        assert penalty is not None
        assert set(penalty.axis_seconds) == {*EFFORT_AXES, BAD_AXIS}
        assert candidate.estimated_duration_seconds + sum(penalty.axis_seconds.values()) + penalty.preferred_seconds \
            + penalty.avoided_seconds + penalty.turn_penalty_seconds == pytest.approx(candidate.cost_seconds, abs=0.5)
        # 区間（ビン）の内訳を足すと候補の内訳になる（道のりのグラフと結果の内訳が同じ秒を見せる）。
        for part in ("preferred_seconds", "avoided_seconds"):
            segments_sum = sum(getattr(segment.penalty, part) for segment in candidate.segments)
            assert segments_sum == pytest.approx(getattr(penalty, part), abs=0.5)
    fastest = fastest_of(candidates)
    assert ways_of(fastest) == [100, 101]
    assert fastest.penalty.preferred_seconds < 0 < fastest.penalty.avoided_seconds
    assert fastest.penalty.axis_seconds[BAD_AXIS] > 0
    # 事実は軸ごとに、名前と単位を付けて返す（画面が軸idで出し分けない）。数の材料の軸は、その軸の秒に一番効いた区間（道100）の
    # 材料の値を材料の宣言の名前と単位で、路面の抵抗は一番効いた路面の区分の名前を出す。
    facts = fastest.facts.axes
    bad = MATERIAL_CATALOG[BAD_MATERIAL]
    assert facts[BAD_AXIS] == AxisFact(label=bad.label, value=1.0, unit=bad.unit)
    assert facts["friction"] == AxisFact(label=definitions.classifications["kind"].classes["local"].label, value=None, unit="")
    assert facts["stopping"].value > 0


#: 南東の角から東へ1km延びる行き止まりの道と、その先のノード。
DEAD_END_WAY, DEAD_END_NODE = 400, 95


async def test_a_u_turn_penalty_goes_into_the_cost_and_its_own_row_but_not_into_the_duration_or_the_penalty_per_km(
    engine_over,
):
    """行き止まりに置いた経由地では折り返すほかに道が無い。Uターンの秒は選ばせないための罰で、実際に失う時間でも道の負担でもない
    ので、費用と内訳の罰の欄にだけ入り、所要時間と到着の予想にも、避ける道の秒にも、1kmあたりの代償（候補の帯の色と周回の並び）
    にも入らない。内訳の和と所要時間で費用になるので、所要時間に罰が入っていれば費用より罰の分だけ多くなる。"""
    end_lat, end_lon = COORDINATES[SOUTH_EAST]
    network = road_network({**WAYS, DEAD_END_WAY: (SOUTH_EAST, DEAD_END_NODE)},
                           {**COORDINATES, DEAD_END_NODE: (end_lat, end_lon + LON_STEP)})

    candidates = (await engine_over(network).generate_via_waypoints(
        at(SOUTH_WEST), [node_point(network, DEAD_END_NODE)], destination=at(NORTH_EAST), max_routes=3,
        start_time=DEPARTURE)).candidates

    assert candidates
    for candidate in candidates:
        assert [turn.direction for turn in candidate.turns].count("uturn") == 1
        penalty = candidate.penalty
        assert (penalty.turn_penalty_seconds, penalty.avoided_seconds) == pytest.approx(
            (TUNING["turn.uturn_share"] * TUNING["turn.uturn_seconds"], 0.0))
        assert candidate.estimated_duration_seconds + penalty.total_seconds == pytest.approx(candidate.cost_seconds, abs=0.5)
        road_penalty = penalty.total_seconds - penalty.turn_penalty_seconds
        assert candidate.penalty_seconds_per_km == pytest.approx(road_penalty / candidate.distance_km, abs=0.1)
