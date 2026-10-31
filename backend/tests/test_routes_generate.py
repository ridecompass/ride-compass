"""`api/routers/routes.py`——ルート生成のHTTPの入口。

確かめるのは、HTTPから見える振る舞いだけ: 要求の検証（422）、ジョブの投稿と取得（202・404）、生成の種類
（周回・目的地・経由地・区間の乗り換え。距離と置いた点の組み合わせ）の振り分け、実際に使った条件のエコー、候補0件の理由、失敗の伝え方、
同時実行とレート制限（429）。

裏の生成は本物の`RouteGenerator`とエンジンを、小さな格子の道路網（`tests/route_world.py`）の上で通す。
差し替えるのはプロセス境界だけ——DBのセッションと天気の予報ファイル（生成の開き方の注入の口`get_route_generation_setup_opener`）・
道路網の置き場・レート制限の記録。

ここで見ないもの:
- 経路の中身（周回が閉じる・一方通行・重みの効き等） → `test_route_generation_behavior.py`
- 候補の並べ方・理由の文面 → `test_route_generator.py`
- レート制限の数え方そのもの → `test_rate_limiter.py`
- 重みの値の検査（公開軸のidだけ・非負） → `test_route_preference.py`。ここでは寄せていることを1行で見る
- 項目ごとの値の範囲（距離・件数等の`Field`の制約）→ 型の宣言が持つ
- 本物の開き方（`api/dependencies.py`がDBのセッションと天気を開いて渡すだけの結線。判断を持たない）
"""

import asyncio
import logging
import re
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import httpx
import pytest

from app.api import dependencies
from app.config import settings
from app.domain.graph import node_key
from app.domain.road_network import RoadNetwork
from app.domain.road_classes import AvoidanceClassification
from app.domain.route_request import ASSUMED_SPEED_KMH, DEFAULT_MAX_ROUTES, MAX_SPLICED_EDGES, MAX_WAYPOINTS
from app.domain.tuning import TUNING_VALUES
from app.infrastructure import rate_limiter
from app.main import app
from app.services.graph_service import GraphService, SearchMemory
from app.services.route_generation_setup import assemble_route_generation_setup
from tests.bound_fake import bound
from tests.road_class_fixture import classification, fact_is, map_layer, replaced_road_classes, road_classes
from tests.route_world import (
    AVOID_AXIS,
    CENTER,
    COORDINATES,
    HIGHWAY,
    NORTH_EAST,
    SOUTH_WEST,
    NetworkRepository,
    Weather,
    at,
    avoid_axis_declared,
    LATTICE,
    grid_network,
    lattice_at,
    lattice_node,
    lattice_ring_edges,
    passes_in_order,
    serve_road_network,
)

#: ASGIの代役がHTTPの相手として名乗る番地（レート制限の鍵になる）。
CLIENT_HOST = "127.0.0.1"
BEYOND_REACH = {"latitude": 37.0, "longitude": 139.8}  # 格子から100km超
JAPANESE = re.compile(r"[぀-ヿ一-鿿]")  # かな・漢字
#: 画面がいつも送る欄（値は画面の既定）。
ALWAYS_SENT = {
    "road_avoidance": {},
    "max_routes": DEFAULT_MAX_ROUTES,
    "assumed_speed_kmh": ASSUMED_SPEED_KMH,
    "start_time": "2026-09-22T08:00:00+09:00",
}


def _point(osm_node_id):
    coordinates = at(osm_node_id)
    return {"latitude": coordinates.latitude, "longitude": coordinates.longitude}


class World:
    """道路網の置き場と天気の代役。`serve`で置いた道路網（Noneなら置き場が空）が次の生成から効く。
    区間の形を返すDBの代役（`NetworkRepository`）は、最後に置いた道路網を読む。"""

    def __init__(self, root: Path):
        self._root = root
        self.weather = Weather()
        self.serve(grid_network())

    def serve(self, network: RoadNetwork | None) -> None:
        if network is not None:
            self.network = network
        serve_road_network(self._root, network)


class GatedWeather(Weather):
    """開くまで生成を止めておく天気の代役（同時実行の上限を観るため）。"""

    def __init__(self):
        super().__init__()
        self.gate = asyncio.Event()

    async def get_departure_wind(self, origin):
        await self.gate.wait()
        return None


@pytest.fixture
def world(override_dependency, road_network_root):
    """格子の道路網・天気の代役と、避けたい材料を読む公開軸1本（`avoid_axis_declared`）。"""
    world = World(road_network_root)

    @asynccontextmanager
    async def open_setup(requested):
        yield assemble_route_generation_setup(GraphService(NetworkRepository(world.network), SearchMemory()), world.weather, requested)

    override_dependency(dependencies.get_route_generation_setup_opener, lambda: open_setup)
    with avoid_axis_declared():
        yield world


@pytest.fixture
async def client(world):
    """`world`の上で動くアプリへのHTTPの口。"""
    transport = httpx.ASGITransport(app=app, client=(CLIENT_HOST, 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def _post(client, **body):
    return await client.post("/api/routes/generate", json={**_point(CENTER), "distance_km": 4.0, **ALWAYS_SENT, **body})


async def _wait(client, job_id):
    for _ in range(1000):
        status = (await client.get(f"/api/routes/generate/{job_id}")).json()
        if status["status"] in ("done", "failed"):
            return status
        await asyncio.sleep(0.01)
    raise AssertionError("ジョブが終わらない")


async def _generate(client, **body):
    response = await _post(client, **body)
    assert response.status_code == 202, response.text
    return await _wait(client, response.json()["job_id"])


def _ends(route):
    return route["node_ids"][0], route["node_ids"][-1]




# --- 生成の種類 ---


async def test_a_loop_is_generated_when_neither_destination_nor_waypoints_are_given(client):
    result = (await _generate(client))["result"]

    assert result["routes"]
    assert all(_ends(route) == (node_key(CENTER), node_key(CENTER)) for route in result["routes"])
    assert result["no_candidates_reason"] is None


@pytest.mark.parametrize(
    ("ending", "end"),
    [
        pytest.param({"destination": _point(NORTH_EAST)}, NORTH_EAST, id="目的地ルートは目的地で終わる"),
        pytest.param({"waypoints": [_point(NORTH_EAST)]}, SOUTH_WEST, id="経由地ルートは出発地へ戻る"),
    ],
)
async def test_a_route_with_a_destination_or_waypoints_ends_where_it_should_with_up_to_the_requested_count(
    client, ending, end,
):
    result = (await _generate(client, **_point(SOUTH_WEST), **ending, distance_km=None, max_routes=2))["result"]

    assert 1 <= len(result["routes"]) <= 2
    assert result["conditions"]["max_routes"] == 2
    # 全長の目標が無ければ、許容も置かない
    assert result["conditions"]["distance_km"] is None and result["conditions"]["distance_tolerance_km"] is None
    assert all(_ends(route) == (node_key(SOUTH_WEST), node_key(end)) for route in result["routes"])


#: 格子のノードの鍵→その地点（応答の`node_ids`から経由地を置き直す）。
POINT_OF_NODE = {node_key(osm): _point(osm) for osm in COORDINATES}


async def test_a_spliced_route_lists_the_placed_waypoints_where_it_passes_them(client):
    """乗り換えて組んだ経路も、置いた経由地を通る所の道のりを置いた順に返す——空だと道のりのグラフに経由地の印が出ない。"""
    body = {**_point(SOUTH_WEST), "destination": _point(NORTH_EAST), "distance_km": None}
    (route, *_) = (await _generate(client, **body, max_routes=1))["result"]["routes"]
    first, *_, last = route["node_ids"][1:-1]
    waypoints = [POINT_OF_NODE[first], POINT_OF_NODE[last]]
    (via, *_) = (await _generate(client, **body, waypoints=waypoints, max_routes=1))["result"]["routes"]

    (spliced,) = (await _generate(client, **body, waypoints=waypoints, spliced_edge_ids=via["edge_ids"]))["result"]["routes"]

    assert len(spliced["waypoint_distances_km"]) == len(waypoints)
    assert spliced["waypoint_distances_km"] == via["waypoint_distances_km"]


async def test_a_spliced_route_that_skips_a_placed_waypoint_lists_none_of_them(client):
    """置いた順に通らない経由地が1つでもあれば、どれも返さない——通った分だけを並べると、何番目の経由地かがずれる。"""
    body = {**_point(SOUTH_WEST), "destination": _point(NORTH_EAST), "distance_km": None}
    (route, *_) = (await _generate(client, **body, max_routes=1))["result"]["routes"]
    first, *_, last = route["node_ids"][1:-1]

    # 経路は`last`を`first`より後に通るので、`last`→`first`の順には通らない。
    (spliced,) = (await _generate(
        client, **body, waypoints=[POINT_OF_NODE[last], POINT_OF_NODE[first]], spliced_edge_ids=route["edge_ids"],
    ))["result"]["routes"]

    assert spliced["waypoint_distances_km"] == []


async def test_a_spliced_route_with_a_road_the_network_does_not_have_says_why(client):
    """道路網に無い区間（古い候補の区間等）は利用者の側の事情なので、ジョブは終わり、0本と理由を返す。"""
    body = {**_point(SOUTH_WEST), "destination": _point(NORTH_EAST), "distance_km": None}
    (route, *_) = (await _generate(client, **body, max_routes=1))["result"]["routes"]

    status = await _generate(client, **body, spliced_edge_ids=[*route["edge_ids"], "way-999-seg0-fwd"])

    assert status["status"] == "done"
    assert status["result"]["routes"] == []
    assert JAPANESE.search(status["result"]["no_candidates_reason"])


async def test_a_spliced_route_outside_the_search_area_fails_as_an_error_of_the_backend(client, world, monkeypatch, caplog):
    """探索の範囲が送られた区間を覆わなかったら、利用者への理由（つながっていない等）にせず、ERRORを残してジョブを失敗させる
    ——理由にすると、範囲の誤りが利用者の操作の誤りに見え、本番で気付けない。範囲を作る側が送られた区間を取りこぼした状態は、
    区間の両端を引く口（`GraphService.edge_endpoints`）を空にして作る。"""
    world.serve(LATTICE)
    monkeypatch.setattr(GraphService, "edge_endpoints", bound(GraphService.edge_endpoints, lambda self, edge_ids: []))

    with caplog.at_level(logging.ERROR):
        status = await _generate(client, **lattice_at(0, 0).model_dump(), spliced_edge_ids=lattice_ring_edges(4))

    assert status["status"] == "failed"
    assert [r for r in caplog.records if r.levelno == logging.ERROR]


async def test_a_distance_with_placed_points_is_the_length_of_the_whole_route(client, world, monkeypatch):
    """経由地を置いても、距離は全長の目標として効く（夕食と銭湯に寄って30kmの周回）。
    探索は置いた点の近くに限らず、全長の目標に足りる広さで探す。"""
    world.serve(LATTICE)
    tolerance_ratio = 0.2
    monkeypatch.setitem(TUNING_VALUES, "search.distance_tolerance_ratio", tolerance_ratio)
    origin, waypoint, target = (1, 1), (1, 2), 12.0

    result = (await _generate(
        client, **lattice_at(*origin).model_dump(), waypoints=[lattice_at(*waypoint).model_dump()], distance_km=target,
    ))["result"]

    assert len(result["routes"]) >= 2
    for route in result["routes"]:
        assert passes_in_order(
            route["node_ids"], lattice_node(*origin), [lattice_node(*waypoint)], lattice_node(*origin),
        )
        assert abs(route["distance_km"] - target) <= target * tolerance_ratio
    assert result["conditions"]["distance_km"] == target


# --- 条件のエコー ---


async def test_the_defaults_that_were_applied_are_echoed(client):
    """画面が見る値と探索が使った値を分けない。省略した項目も、実際に使った値で返す。"""
    conditions = (await _generate(client))["result"]["conditions"]

    assert conditions["route_preference"] == {AVOID_AXIS: 0.0}
    assert conditions["waypoints"] is None and conditions["destination"] is None
    assert conditions["corrected_destination"] is None


async def test_the_overrides_that_were_sent_are_echoed(client):
    """保存したレスポンスの条件をそのまま送り直せば、同じ条件で生成し直せる。"""
    definitions = road_classes(
        {"kind": classification({"local": [fact_is(HIGHWAY, "residential")]})},
        map_layers={"kind": map_layer()},
        avoidance_classifications={"kind": AvoidanceClassification(overrides={})},
    )
    with replaced_road_classes(definitions):
        conditions = (await _generate(
            client, route_preference={AVOID_AXIS: 2.0}, road_avoidance={"kind.local": "avoid"}, assumed_speed_kmh=25.0,
        ))["result"]["conditions"]

    assert conditions["route_preference"] == {AVOID_AXIS: 2.0}
    assert conditions["road_avoidance"] == {"kind.local": "avoid"}
    assert conditions["assumed_speed_kmh"] == 25.0


@pytest.mark.parametrize(("field", "tuning_id", "values", "applied"), [
    ("penalty_strength", "evaluation.penalty_strength", (0.37, 0.61), (0.37, 0.61)),
    # 許容は割合の較正値で、目標4kmに掛けた長さを使って返す
    ("distance_tolerance_km", "search.distance_tolerance_ratio", (0.25, 0.5), (1.0, 2.0)),
])
async def test_the_calibrated_value_at_the_time_of_generation_is_applied(
    client, monkeypatch, field, tuning_id, values, applied,
):
    """管理画面で変えた較正値は、プロセスを入れ替えずに次の生成から効き、使った値として返る。"""
    echoed = []
    for value in values:
        monkeypatch.setitem(TUNING_VALUES, tuning_id, value)
        echoed.append((await _generate(client))["result"]["conditions"][field])

    assert tuple(echoed) == pytest.approx(applied)


@pytest.mark.parametrize(("sent", "applied"), [
    ("2026-09-22T08:00:00", "2026-09-22T08:00:00+09:00"),          # 時差の無い値は日本時間
    ("2026-09-21T23:00:00+00:00", "2026-09-22T08:00:00+09:00"),    # 時差のある値は日本時間へ直す
])
async def test_the_departure_time_is_read_in_japan_time(client, sent, applied):
    conditions = (await _generate(client, start_time=sent))["result"]["conditions"]

    assert datetime.fromisoformat(conditions["start_time"]) == datetime.fromisoformat(applied)
    assert conditions["start_time"].endswith("+09:00")


async def test_a_destination_moved_to_the_nearest_reachable_road_is_echoed(client, world):
    world.serve(grid_network(island=True))

    conditions = (await _generate(
        client, **_point(SOUTH_WEST), destination=_point(91), distance_km=None,
    ))["result"]["conditions"]

    assert conditions["corrected_destination"] == _point(NORTH_EAST)
    assert conditions["destination"] == _point(91)


# --- 要求の検証 ---


@pytest.mark.parametrize("body", [
    {"route_preference": {}},                                        # 公開軸を全部書いていない
    {"route_preference": {AVOID_AXIS: -1.0}},                        # 値の検査（`check_axis_weights`）へ寄せている
])
async def test_a_request_outside_what_can_be_generated_is_refused_before_any_job(client, body):
    response = await _post(client, **body)

    assert response.status_code == 422


@pytest.mark.parametrize("body", [
    {"distance_km": None},                                           # 出発地だけで、距離も経由地・目的地も無い
    {"waypoints": [_point(CENTER)] * (MAX_WAYPOINTS + 1)},
    {"destination": BEYOND_REACH},
    {"destination": _point(NORTH_EAST), "spliced_edge_ids": ["way-100-seg0-fwd"] * (MAX_SPLICED_EDGES + 1)},
])
async def test_a_request_the_screen_can_send_is_refused_in_words_the_rider_reads(client, body):
    """画面は誤りの文をそのまま結果欄へ出す。前置き（「Value error, 」）の付かない日本語の文だけが返る。"""
    response = await _post(client, **body)

    messages = [error["msg"] for error in response.json()["detail"]]
    assert response.status_code == 422
    assert messages and all(JAPANESE.search(m) and not m.startswith("Value error") for m in messages)


# --- ジョブ ---


async def test_a_job_that_is_not_known_is_404(client):
    assert (await client.get("/api/routes/generate/no-such-job")).status_code == 404


async def test_a_failed_job_says_so_without_leaking_its_internals(client, world):
    """例外の中身（接続先・SQL）はログだけに残す。失敗しても同時実行の枠は返る（上限より多く続けて投げても受け付ける）。"""
    world.serve(None)

    statuses = [await _generate(client) for _ in range(settings.generate_max_concurrent + 1)]

    assert {s["status"] for s in statuses} == {"failed"}
    assert all("置き場" not in s["error"] and s["error"] for s in statuses)


async def test_jobs_beyond_the_concurrency_limit_are_refused_at_once(client, world):
    """待たせずに429を返す（連打やブラウザのリトライで裏の負荷を積み上げない）。枠が空けばまた受け付ける。"""
    world.weather = GatedWeather()
    running = [await _post(client) for _ in range(settings.generate_max_concurrent)]

    # 上限を越えた投稿が枠の空きを待ってしまうと、応答が返らない。待たせないことを期限で確かめる。
    refused = await asyncio.wait_for(_post(client), timeout=5)

    world.weather.gate.set()
    for response in running:
        assert response.status_code == 202
        assert (await _wait(client, response.json()["job_id"]))["status"] == "done"
    assert refused.status_code == 429
    assert (await _generate(client))["status"] == "done"


async def test_too_many_requests_from_one_client_are_refused(client):
    for _ in range(settings.generate_rate_limit_per_minute - 1):
        rate_limiter.check_rate_limit(f"generate:{CLIENT_HOST}", settings.generate_rate_limit_per_minute)

    assert (await _generate(client))["status"] == "done"
    assert (await _post(client)).status_code == 429

