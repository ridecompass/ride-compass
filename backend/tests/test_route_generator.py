"""`services/route_generator.py`——ルート生成の戦略層（距離あり・距離なし・乗り換えの入口）。

ここで見ないもの:
- 折返し点の選定・経路探索・評価の中身 → `RoadGraphEngine`（`test_route_generation_behavior.py`と、その判断の部品は`test_route_search.py`）。ここでは代役に置き換える
- 区間から候補への集約の計算（距離加重平均・丸め） → `test_route.py`・`domain/difficulty.py`のテスト
- 距離あり・距離なしのどちらの入口を使うか（要求の検証が選ぶ）とAPIの受け口 → `test_routes_generate.py`
- エンジンへ渡す引数（探索の範囲・経由地の並び・出発時刻・候補数）と、エンジンを呼んだか・何回か → 読むだけの呼び出しなので
  確かめない。経由地を順に通って起点か目的地で終わること・目的地の補正を引き継ぐことは`test_route_generation_behavior.py`が経路で見る
- 算出不能の候補を末尾へ回すことの目的地の側 → 周回と目的地が同じ並びの鍵（`domain/route_search.py: difficulty_order`）を通るので、
  周回の並びのテストが見る
- 前の生成の理由・目的地の補正を持ち越さないこと → 本番は生成ごとに`RouteGenerator`を作るので、持ち越す状態が起こらない

エンジンの代役は、各メソッドを`RoadGraphEngine`の同名メソッドの署名へ当ててから呼ぶ（`bound`）。応答を返すだけで、呼ばれ方を記録しない。
代役が返す探索結果・経路は本物の型（`TracedLoop`・`LoopTurnaround`・`EvaluatedRoute`・`FixedLegs`）で作る。
探索の文脈（`context`）は戦略層にとって中身を読まない値で、読むのは`destination_correction`の
1属性だけのため、その属性だけを持つ器で渡す。
"""

import logging
from datetime import datetime
from types import SimpleNamespace

import pytest

from app.domain.errors import RoutingError, SearchAreaTooLargeError
from app.domain.loop_routing import LoopTurnaround, TracedLoop
from app.domain.route import Coordinates, EvaluatedRoute, RouteCandidate, RouteSegmentDetail
from app.domain.route_request import DEFAULT_MAX_ROUTES, MAX_ROUTES, FixedPoints
from app.domain.time_zone import JST
from app.services import route_generator
from app.services.road_graph_context import FixedLegs
from app.services.road_graph_engine import RoadGraphEngine
from app.services.route_generator import RouteGenerator
from tests.bound_fake import bound
from tests.route_world import NO_POINTS

ORIGIN = Coordinates(latitude=35.6789, longitude=139.7712)
WAYPOINT = Coordinates(latitude=35.69, longitude=139.78)
DESTINATION = Coordinates(latitude=35.70, longitude=139.80)
START = datetime(2026, 9, 24, 8, 0, tzinfo=JST)
AREA_PHRASE = "候補を生成できませんでした。対応エリア外の可能性があります。"
UNREACHABLE = "指定した経由地・目的地を通る経路が見つかりませんでした。地点や除外する道路の設定を変えてお試しください。"
RETRY = "距離や除外する道路の設定を変えてお試しください。"


def _segment(difficulty: float | None, **fields) -> RouteSegmentDetail:
    return RouteSegmentDetail(
        start_latitude=0.0, start_longitude=0.0, end_latitude=0.0, end_longitude=0.0,
        cumulative_distance_km=0.0, distance_km=1.0, elevations=[],
        road_classes={}, difficulty=difficulty, **fields,
    )


def _candidate(key: str, difficulty: float | None = 10.0, **fields) -> EvaluatedRoute:
    """区間1本（1km・難易度`difficulty`）を持つ経路。戦略層は名前を付け替えうるので、どの候補かは`edge_ids`で見分ける。"""
    return EvaluatedRoute(**{
        "direction_label": f"方位-{key}", "distance_km": 1.0, "geometry": {"type": "LineString", "coordinates": []},
        "elevation_gain_m": None, "segments": [_segment(difficulty)], "estimated_duration_seconds": None,
        "wind_unavailable": False, "missing_travel_data_share": None, "axis_raw_values": {},
        "material_category_shares": {}, "edge_ids": [key], "edge_point_offsets": [], "node_ids": [], "turns": [], "points": [],
        "waypoint_distances_km": [], **fields,
    })


def _route(key: str, distance_km: float = 10.0, bearing: int | None = 0) -> TracedLoop:
    return TracedLoop(bearing=bearing, distance_km=distance_km, data=[key], leg_of_edge=[0], waypoint_offsets=[],
                      reversible=False)


def _turnaround(outcome: TracedLoop | Exception) -> LoopTurnaround:
    """復路探索の結果（または失敗）を`data`に抱えた折返し点。`data`はエンジンだけが読む。"""
    return LoopTurnaround(bearing=0, data=outcome)


def _keys(candidates: list[RouteCandidate]) -> list[str]:
    return [c.edge_ids[0] for c in candidates]


def _identities(candidates: list[RouteCandidate]) -> list[tuple[str, str, str]]:
    """候補ごとの（id・種類・名前）。"""
    return [(c.id, c.kind, c.direction_label) for c in candidates]


def _fastest(candidates: list[RouteCandidate]) -> list[str]:
    return [c.edge_ids[0] for c in candidates if c.is_fastest]


def _as_engine(fake):
    return bound(getattr(RoadGraphEngine, fake.__name__), fake)


class FakeEngine:
    """`RoadGraphEngine`の代役（層の境目）。`routes`は評価の答え（経路の鍵 → 候補）。終点は、`closes`を渡さなければ
    目的地を置かないときだけ出発地（`True`を渡すと、目的地が出発地のNodeへ寄ったときの前段）。"""

    def __init__(self, *, routes=None, context=..., prepare_error=None, turnarounds=(), similar=(),
                 fixed_error=None, via=(), fastest=None, build_error=None, drop_evaluated=False, closes=None):
        self.routes = routes or {}
        self.context = SimpleNamespace(destination_correction=None) if context is ... else context
        self.prepare_error = prepare_error
        self.turnarounds = list(turnarounds)
        self.similar = set(similar)
        self.fixed_error = fixed_error
        self.via = list(via)
        self.fastest = fastest
        self.build_error = build_error
        self.drop_evaluated = drop_evaluated
        self.closes = closes

    @_as_engine
    async def prepare(self, origin, points, radius_km, now):
        if self.prepare_error is not None:
            raise self.prepare_error
        return self.context

    @_as_engine
    async def trace_fixed_points(self, context, points):
        if self.fixed_error is not None:
            raise self.fixed_error
        closes = points.destination is None if self.closes is None else self.closes
        count = len(points.waypoints)
        return FixedLegs(segments=[[0]] * count, nodes=[0] * (count + 1), length_m=0.0,
                         end_node=0 if closes else 1, end_point=ORIGIN if closes else DESTINATION)

    @_as_engine
    async def select_loop_turnarounds(self, context, fixed, distance_km, distance_tolerance_km, pool_size):
        return list(self.turnarounds)

    @_as_engine
    async def trace_loop_from_turnaround(self, context, fixed, turnaround):
        if isinstance(turnaround.data, Exception):
            raise turnaround.data
        return turnaround.data

    @_as_engine
    def is_loop_too_similar(self, context, fixed, candidate, accepted):
        return candidate.data[0] in self.similar

    @_as_engine
    async def select_via_nodes(self, context, fixed, max_routes):
        return list(self.via)

    @_as_engine
    async def select_fastest_route(self, context, fixed):
        return self.fastest

    @_as_engine
    def build_traced_from_edge_ids(self, context, edge_ids, destination):
        if self.build_error is not None:
            raise self.build_error
        return TracedLoop(
            bearing=None, distance_km=3.0, data=list(edge_ids), leg_of_edge=[0] * len(edge_ids), waypoint_offsets=[],
            reversible=False)

    @_as_engine
    def repeated_shares(self, context, traced):
        return [0.0] * len(traced)

    @_as_engine
    async def evaluate_loops(self, context, traced, start_time):
        return [] if self.drop_evaluated else [self.routes[t.data[0]] for t in traced]


async def _loops(
    engine: FakeEngine | RouteGenerator, max_routes: int = DEFAULT_MAX_ROUTES, points: FixedPoints = NO_POINTS,
) -> list[RouteCandidate]:
    """目標10km±1kmの距離ありの生成（`points`を省けば周回）。理由を読むテストは、作った`RouteGenerator`を渡す。"""
    generator = engine if isinstance(engine, RouteGenerator) else RouteGenerator(engine)
    return await generator.generate_loops(ORIGIN, 10.0, 1.0, max_routes, START, points=points)


async def _no_distance(engine: FakeEngine | RouteGenerator, waypoints, destination, max_routes: int = 3):
    generator = engine if isinstance(engine, RouteGenerator) else RouteGenerator(engine)
    return await generator.generate_via_waypoints(ORIGIN, waypoints, destination, max_routes, START)


ENTRANCES = {
    "loops": lambda generator: generator.generate_loops(ORIGIN, 10.0, 1.0, DEFAULT_MAX_ROUTES, START, NO_POINTS),
    "waypoints": lambda generator: generator.generate_via_waypoints(ORIGIN, [WAYPOINT], None, 1, START),
    "destination": lambda generator: generator.generate_via_waypoints(ORIGIN, [], DESTINATION, 1, START),
    "spliced": lambda generator: generator.generate_spliced_route(ORIGIN, DESTINATION, ("e1",), START),
}


def _warned(caplog) -> bool:
    return any(r.name == route_generator.logger.name and r.levelno >= logging.WARNING for r in caplog.records)


# ---- どの入口にも共通すること ----


@pytest.mark.parametrize(
    ("entrance", "phrase"),
    [("loops", AREA_PHRASE), ("waypoints", AREA_PHRASE), ("destination", AREA_PHRASE),
     ("spliced", "ルートを組み立てられませんでした。")],
)
async def test_no_road_data_gives_no_candidates_and_says_why(entrance, phrase, caplog):
    generator = RouteGenerator(FakeEngine(context=None))

    with caplog.at_level(logging.WARNING, logger=route_generator.logger.name):
        assert await ENTRANCES[entrance](generator) == []

    assert generator.last_no_candidates_reason == f"起点付近の道路データが未整備のため、{phrase}"
    assert _warned(caplog)


@pytest.mark.parametrize(
    ("error", "reason", "logged"),
    [
        (SearchAreaTooLargeError(edges=1_300_000, limit=1_200_000), "探索範囲の道路が多すぎるため", "edges=1300000"),
        (RoutingError("no accessible node near origin"), "起点から走り出せる道が見つかりませんでした。", "no accessible node"),
    ],
)
async def test_a_search_area_that_cannot_be_used_gives_no_candidates_and_says_why(error, reason, logged, caplog):
    """どの入口も上の未整備と同じ所で土台を作るので、ほかの断り方は1つの入口で見る。"""
    generator = RouteGenerator(FakeEngine(prepare_error=error))

    with caplog.at_level(logging.WARNING, logger=route_generator.logger.name):
        assert await ENTRANCES["destination"](generator) == []

    assert generator.last_no_candidates_reason.startswith(reason)
    assert any(logged in r.getMessage() for r in caplog.records)


# ---- 距離あり（周回） ----


def test_turnaround_pool_covers_the_requested_routes_within_what_the_diverse_selection_can_take():
    """多様な選定（`domain/routing.py: select_diverse_by_overlap`）は採用済みを64bitのマスクで持つため、64件まで。"""
    for max_routes in range(1, MAX_ROUTES + 1):
        assert max_routes <= route_generator.turnaround_pool_size(max_routes) <= 64


async def test_loops_without_turnarounds_say_how_far_out_was_searched(caplog):
    generator = RouteGenerator(FakeEngine())

    with caplog.at_level(logging.WARNING, logger=route_generator.logger.name):
        # 片道が数十kmになる距離にする（数kmでは、小数1桁へ丸めると m から km への換算の誤りが消える）。
        assert await generator.generate_loops(ORIGIN, 200.0, 20.0, DEFAULT_MAX_ROUTES, START, NO_POINTS) == []

    assert generator.last_no_candidates_reason == f"起点から片道90.0〜95.7kmで到達できる折返し地点が見つかりませんでした。{RETRY}"
    assert _warned(caplog)


async def test_loops_stop_once_enough_routes_are_accepted():
    keys = ["a", "b", "c", "d"]
    engine = FakeEngine(turnarounds=[_turnaround(_route(k)) for k in keys], routes={k: _candidate(k) for k in keys})

    assert len(await _loops(engine, max_routes=2)) == 2


async def test_loops_pass_over_turnarounds_whose_return_trip_fails(caplog):
    engine = FakeEngine(
        turnarounds=[_turnaround(RoutingError("復路なし")), _turnaround(RuntimeError("不具合")), _turnaround(_route("a"))],
        routes={"a": _candidate("a")},
    )

    with caplog.at_level(logging.DEBUG, logger=route_generator.logger.name):
        assert _keys(await _loops(engine)) == ["a"]

    # 想定外の例外だけは、エンジンの不具合としてスタックトレース付きのERRORで残す
    (error,) = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert isinstance(error.exc_info[1], RuntimeError)


async def test_loops_keep_only_routes_within_the_distance_tolerance():
    lengths = {"edge": 11.0, "over": 11.5, "under": 8.9}
    engine = FakeEngine(turnarounds=[_turnaround(_route(k, distance_km=d)) for k, d in lengths.items()],
                        routes={k: _candidate(k) for k in lengths})

    # 目標±許容のちょうど端は含む。目標より短い側も同じ幅で外す
    assert _keys(await _loops(engine)) == ["edge"]


async def test_loops_drop_a_route_too_similar_to_one_already_accepted():
    keys = ["a", "b", "c"]
    engine = FakeEngine(turnarounds=[_turnaround(_route(k)) for k in keys], similar={"b"},
                        routes={k: _candidate(k) for k in keys})

    assert sorted(_keys(await _loops(engine))) == ["a", "c"]


@pytest.mark.parametrize(
    ("outcomes", "reason"),
    [
        ([RoutingError("復路なし")], "1件の折返し候補で復路の探索に失敗しました[除外設定をご確認ください]。"),
        ([_route("x", distance_km=20.0), _route("y", distance_km=1.0)], "2件の周回候補は指定距離[10.0km±1.0km]から外れました。"),
        ([RoutingError("復路なし"), _route("x", distance_km=20.0)],
         "1件の折返し候補で復路の探索に失敗しました[除外設定をご確認ください]、1件の周回候補は指定距離[10.0km±1.0km]から外れました。"),
    ],
)
async def test_loops_that_all_fall_out_say_why(outcomes, reason, caplog):
    generator = RouteGenerator(FakeEngine(turnarounds=[_turnaround(o) for o in outcomes]))

    with caplog.at_level(logging.WARNING, logger=route_generator.logger.name):
        assert await _loops(generator) == []

    assert generator.last_no_candidates_reason == reason + RETRY
    assert _warned(caplog)


# ---- 距離あり・置いた点あり ----


LOOPS_NAMED_BY_BEARING = [("loop-00", "loop", "方位-easy"), ("loop-01", "loop", "方位-hard")]


@pytest.mark.parametrize(
    ("points", "closes", "identities"),
    [
        # 出発地へ戻るなら周回と同じく方位の名前
        (FixedPoints(waypoints=[WAYPOINT], destination=None), None, LOOPS_NAMED_BY_BEARING),
        # 目的地が出発地へ寄ったら、目的地を置かない周回と同じ
        (FixedPoints(waypoints=[], destination=DESTINATION), True, LOOPS_NAMED_BY_BEARING),
        # 目的地で終わるなら目的地ルート
        (FixedPoints(waypoints=[], destination=DESTINATION), None,
         [("destination-00", "destination", "目的地ルート"), ("destination-01", "destination", "目的地ルート")]),
    ],
)
async def test_distance_routes_through_placed_points_are_named_by_where_they_end(points, closes, identities):
    engine = FakeEngine(turnarounds=[_turnaround(_route(k)) for k in ("hard", "easy")], closes=closes,
                        routes={"hard": _candidate("hard", 30.0), "easy": _candidate("easy", 10.0)})

    result = await _loops(engine, points=points)

    # 距離を決めた生成は、所要時間が最短の1本を足さない（目標の距離と噛み合わない）
    assert (_identities(result), _fastest(result)) == (identities, [])


async def test_distance_routes_through_placed_points_without_a_relay_say_so(caplog):
    generator = RouteGenerator(FakeEngine())

    with caplog.at_level(logging.WARNING, logger=route_generator.logger.name):
        assert await _loops(generator, points=FixedPoints(waypoints=[WAYPOINT], destination=None)) == []

    assert generator.last_no_candidates_reason == (
        "置いた地点を通って全長10.0km前後になる経路が見つかりませんでした。距離や地点、除外する道路の設定を変えてお試しください。")
    assert _warned(caplog)


# ---- 距離なし・経由地あり ----


@pytest.mark.parametrize(
    ("destination", "closes"),
    [(None, None), (DESTINATION, True)],  # 目的地を置かない・目的地が出発地へ寄った
)
async def test_waypoint_routes_back_to_the_origin_come_in_several_without_the_fastest(destination, closes):
    engine = FakeEngine(via=[_route(k, bearing=None) for k in ("hard", "easy", "mid")], closes=closes,
                        fastest=_route("fastest", bearing=None),
                        routes={"hard": _candidate("hard", 30.0), "easy": _candidate("easy", 10.0),
                                "mid": _candidate("mid", 20.0), "fastest": _candidate("fastest", 5.0)})

    result = await _no_distance(engine, [WAYPOINT], destination, max_routes=2)

    # 難易度の高い側から切る
    assert _identities(result) == [("loop-00", "loop", "経由地ルート"), ("loop-01", "loop", "経由地ルート")]
    assert (_keys(result), _fastest(result)) == (["easy", "mid"], [])


@pytest.mark.parametrize("failing", ["fixed_error", "via"])  # 置いた点どうし・最後の点から終点まで
async def test_waypoints_that_cannot_be_connected_give_no_candidates_and_say_why(failing, caplog):
    generator = RouteGenerator(FakeEngine(
        **({"fixed_error": RoutingError("到達不能")} if failing == "fixed_error" else {"via": []}),
    ))

    with caplog.at_level(logging.WARNING, logger=route_generator.logger.name):
        assert await _no_distance(generator, [WAYPOINT], None) == []

    assert generator.last_no_candidates_reason == UNREACHABLE
    assert _warned(caplog)


# ---- 距離なし・経由地なし（目的地ルート） ----


def _destination_engine(fastest: str | None, /, **difficulties: float) -> FakeEngine:
    """代替経路は`difficulties`の順に返り、`fastest`は所要時間が最短の1本（代替経路と同じ鍵ならその経路）。"""
    routes = {k: _candidate(k, d) for k, d in difficulties.items()}
    return FakeEngine(via=[_route(k) for k in difficulties if k != "fastest"],
                      fastest=None if fastest is None else _route(fastest), routes=routes)


async def test_destination_routes_add_the_fastest_and_are_ordered_easiest_first():
    engine = _destination_engine("fastest", hard=30.0, easy=10.0, fastest=20.0)

    result = await _no_distance(engine, [], DESTINATION)

    assert _keys(result) == ["easy", "fastest", "hard"]
    assert _identities(result) == [(f"destination-0{i}", "destination", "目的地ルート") for i in range(3)]
    assert _fastest(result) == ["fastest"]


@pytest.mark.parametrize(
    ("max_routes", "expected", "fastest"),
    [
        (2, ["easy", "fastest"], ["fastest"]),  # 難易度で最下位の基準線を残し、その次に難しい候補を切る
        (1, ["easy"], []),  # 1本だけ返すときは基準線を残さない——軸の重みが結果に現れなくなる
    ],
)
async def test_destination_routes_cut_the_hardest_but_keep_the_fastest_unless_returning_one(max_routes, expected, fastest):
    engine = _destination_engine("fastest", hard=30.0, easy=10.0, fastest=50.0)

    result = await _no_distance(engine, [], DESTINATION, max_routes=max_routes)

    assert (_keys(result), _fastest(result)) == (expected, fastest)


@pytest.mark.parametrize(
    ("fastest", "difficulties", "expected"),
    [
        ("a", {"a": 10.0}, ["a"]),  # 比べる相手が無いので、基準として印を付けない
        (None, {"a": 10.0, "b": 10.0}, ["a", "b"]),  # 最速の経路が引けなければ、代替経路だけを返す
    ],
)
async def test_destination_routes_without_another_route_to_compare_mark_no_fastest(fastest, difficulties, expected):
    result = await _no_distance(_destination_engine(fastest, **difficulties), [], DESTINATION)

    assert (_keys(result), _fastest(result)) == (expected, [])


async def test_destination_without_alternatives_says_why(caplog):
    generator = RouteGenerator(FakeEngine())

    with caplog.at_level(logging.WARNING, logger=route_generator.logger.name):
        assert await _no_distance(generator, [], DESTINATION) == []

    assert generator.last_no_candidates_reason == (
        "指定した目的地までの経路が見つかりませんでした。地点や除外する道路の設定を変えてお試しください。")
    assert _warned(caplog)


async def test_a_destination_on_the_origin_without_a_distance_or_waypoints_is_refused_as_nothing_to_generate(caplog):
    """出発地のすぐ隣で折り返すだけの経路を出さない。目的地を置かない同じ要求（要求の検証が断る）と同じ文で断る。"""
    generator = RouteGenerator(FakeEngine(via=[_route("a", bearing=None)], routes={"a": _candidate("a")}, closes=True))

    with caplog.at_level(logging.WARNING, logger=route_generator.logger.name):
        assert await _no_distance(generator, [], DESTINATION) == []

    assert generator.last_no_candidates_reason == "距離か、経由地・目的地を指定してください。"
    assert _warned(caplog)


# ---- 区間の乗り換え ----


async def test_spliced_route_is_labelled_as_one_combined_route():
    result = await ENTRANCES["spliced"](RouteGenerator(FakeEngine(routes={"e1": _candidate("e1")})))

    assert _identities(result) == [("spliced-00", "spliced", "組み合わせたルート")]


async def test_spliced_route_that_does_not_connect_says_so_without_internal_ids(caplog):
    generator = RouteGenerator(FakeEngine(build_error=RoutingError("edge_id=osm-123 がつながっていない")))

    with caplog.at_level(logging.WARNING, logger=route_generator.logger.name):
        assert await generator.generate_spliced_route(ORIGIN, DESTINATION, ("osm-123",), START) == []

    assert generator.last_no_candidates_reason == (
        "組み合わせた経路がつながっていないため評価できませんでした。区間の選び直しか、ルートの再生成をお試しください。")
    # 原因（内部の識別子を含む）はログにだけ残す
    assert any("osm-123" in r.getMessage() for r in caplog.records)
