"""`infrastructure/jma_tile_client.py`——気象庁のタイルと時刻一覧の取得、キャッシュの持ち分け、上流への間隔。

入口は`JmaTileClient`の`get_cached`・`fetch`・`store`・`get`と、`is_target_times_path`・`get_target_times`。
上流はrespxの経路、Redisはfakeredis、時計はfreezegunで与え、待ちは時計を進める代役で受ける。
どのパスが「配信前に404が返る地物」か（`infrastructure/jma_tile_paths.py: is_final_absence`）も、ここで404を覚えるか
どうかで見る。入力には宣言にある地物（落雷）とタイル（土砂キキクル）のパスを1つずつ使う。

ここで見ないもの:
- 中身が空のタイルをフラグで持つこと・Redisの値の形 → `test_jma_tile_redis_cache.py`
- 降水のタイルの色の塗り替え → `test_jma_tile_recolor.py`。ここでは取得したタイルに塗り替えが当たることだけを見る
- 404・502・`Cache-Control`への振り分け、レート制限を当てる順序 → `test_jma_tile_routes.py`
- 解いた行をコマにする読み方 → `test_jma_tile_specs.py`
- 上流が404・失敗を返した取得も間隔に数えること → 待ちは結果を問わず問い合わせの前に置かれる（`fetch`の先頭）
- 別のパスのタイルが混ざらないこと → `test_jma_tile_redis_cache.py`
- 上流の失敗の種類（404・失敗の応答・通信の失敗）の見分け → `test_http_client.py`
"""

import asyncio
import types

import httpx
import pytest
import respx
from PIL import Image

from app.domain.jma_tile_specs import JmaFrame, TargetTimesRow
from app.domain.weather_display import PRECIPITATION_COLOR_STOPS
from app.infrastructure.jma_tile_recolor import JMA_PRECIPITATION_TILE_COLORS
from app.infrastructure import jma_tile_client
from app.infrastructure.http_client import UPSTREAM_NOT_FOUND
from app.infrastructure.jma_tile_client import JmaTileClient, JmaTileSharedState
from tests.fake_external_log import record_external_calls
from tests.fake_http import client_for
from tests.test_jma_tile_content import encode
from tests.test_jma_tile_recolor import palette_tile, pixels, rgba

TILE = "bosai/jmatile/data/risk/20260101000000/none/20260101000000/surf/land/6/57/25.png"
OTHER_TILE = "bosai/jmatile/data/risk/20260101000000/none/20260101000000/surf/land/6/57/26.png"
PRECIPITATION_TILE = "bosai/jmatile/data/nowc/20260101000000/none/20260101000000/surf/hrpns/6/57/25.png"
LISTING = "bosai/jmatile/data/nowc/targetTimes_N1.json"
FEATURES = "bosai/jmatile/data/nowc/20260101000000/none/20260101000000/surf/liden/data.geojson?id=liden"
OPAQUE = b"\x89PNG not decoded by the client"
NOTHING_TO_DRAW = encode(Image.new("RGBA", (4, 4), (0, 0, 0, 0)))


@pytest.fixture
def upstream():
    """気象庁の代役。応答はテストごとに経路を足して決め、経路に無いURLを引けば失敗する。"""
    return respx.Router(base_url=jma_tile_client.UPSTREAM_HOST)


@pytest.fixture
def waits(monkeypatch, clock):
    """上流への間隔の待ちを記録し、待った分だけ止めた時計を進める。"""
    recorded: list[float] = []

    async def sleep(seconds: float) -> None:
        recorded.append(seconds)
        clock.tick(seconds)

    # 錠は本物のまま使う（待ちだけを受ける）。
    monkeypatch.setattr(jma_tile_client, "asyncio", types.SimpleNamespace(sleep=sleep, Lock=asyncio.Lock))
    return recorded


@pytest.fixture
def client():
    """使い捨てのクライアントを作る。リクエストをまたぐ状態（時刻一覧のキャッシュ・上流への間隔の起点）は、
    本番の組み立てと同じく1つを共有し、テストごとに空から始まる。"""
    shared = JmaTileSharedState()
    return lambda upstream: JmaTileClient(client_for(upstream), shared)


async def test_nothing_is_cached_at_first_and_a_lookup_never_asks_upstream(monkeypatch, upstream, fake_redis, client):
    recorded = record_external_calls(monkeypatch, jma_tile_client)

    assert await client(upstream).get_cached(TILE) is None
    assert await client(upstream).get_cached(LISTING) is None
    assert [call.fields["cache"] for call in recorded] == ["miss", "miss"]


async def test_a_fetched_tile_is_returned_and_then_served_from_the_cache(monkeypatch, upstream, fake_redis, client):
    recorded = record_external_calls(monkeypatch, jma_tile_client)
    upstream.get(f"/{TILE}").respond(content=OPAQUE, content_type="image/png")

    fetched = await client(upstream).fetch(TILE)
    cached = await client(upstream).get_cached(TILE)

    assert fetched == cached == (OPAQUE, "image/png")
    assert upstream.calls.call_count == 1
    assert recorded[0].fields | {"path": TILE} == {"path": TILE, "cache": "miss", "result": "ok", "status": 200}
    assert recorded[1].fields["cache"] == "hit"


async def test_a_fetched_precipitation_tile_is_served_and_cached_in_the_legend_colors(upstream, fake_redis, client):
    upstream.get(f"/{PRECIPITATION_TILE}").respond(
        content=palette_tile(list(JMA_PRECIPITATION_TILE_COLORS)), content_type="image/png"
    )

    fetched = await client(upstream).fetch(PRECIPITATION_TILE)
    cached = await client(upstream).get_cached(PRECIPITATION_TILE)

    assert fetched == cached
    assert pixels(fetched[0])[1:] == [rgba(stop.color) for stop in PRECIPITATION_COLOR_STOPS]


async def test_a_fetched_tile_with_nothing_to_draw_reads_the_same_the_first_time_as_from_the_cache(upstream, fake_redis, client):
    """初めての取得だけが中身を返すと、同じタイルが1回目は透明な画像、2回目からは「無い」で届く。"""
    upstream.get(f"/{TILE}").respond(content=NOTHING_TO_DRAW, content_type="image/png")

    fetched = await client(upstream).fetch(TILE)
    cached = await client(upstream).get_cached(TILE)

    assert fetched is UPSTREAM_NOT_FOUND
    assert cached is UPSTREAM_NOT_FOUND


async def test_a_locally_built_tile_with_nothing_to_draw_reads_as_nothing_to_draw(upstream, fake_redis, client):
    assert await client(upstream).store(TILE, NOTHING_TO_DRAW, "image/png") is UPSTREAM_NOT_FOUND


async def test_a_fetch_without_a_content_type_is_served_as_generic_bytes(upstream, fake_redis, client):
    upstream.get(f"/{TILE}").respond(content=OPAQUE)

    assert await client(upstream).fetch(TILE) == (OPAQUE, "application/octet-stream")


async def test_tiles_are_shared_through_redis_and_time_listings_are_kept_in_this_process(
    upstream, fake_redis, redis_server, waits, client
):
    """タイルは全プロセスで共有し、時刻一覧は2分で変わるのでプロセス内に置く。Redisが落ちると片方だけが消える。"""
    upstream.get(f"/{TILE}").respond(content=OPAQUE, content_type="image/png")
    upstream.get(f"/{LISTING}").respond(json=[], content_type="application/json")
    await client(upstream).fetch(TILE)
    await client(upstream).fetch(LISTING)

    redis_server.connected = False

    assert await client(upstream).get_cached(TILE) is None
    assert await client(upstream).get_cached(LISTING) == (b"[]", "application/json")


async def test_a_missing_tile_is_told_apart_from_failures_and_remembered_as_nothing_to_draw(
    monkeypatch, upstream, fake_redis, client
):
    """疎な格子の穴は正常系なので、失敗として数えず（WARNINGも出さず）、次からは上流へ問い合わせない。"""
    recorded = record_external_calls(monkeypatch, jma_tile_client)
    upstream.get(f"/{TILE}").respond(404)

    assert await client(upstream).fetch(TILE) is UPSTREAM_NOT_FOUND

    assert recorded[0].fields["result"] == "ok"
    assert recorded[0].fields["status"] == 404
    assert await client(upstream).get_cached(TILE) is UPSTREAM_NOT_FOUND


async def test_a_missing_time_listing_is_remembered_in_this_process(upstream, fake_redis, redis_server, client):
    upstream.get(f"/{LISTING}").respond(404)

    assert await client(upstream).fetch(LISTING) is UPSTREAM_NOT_FOUND

    redis_server.connected = False
    assert await client(upstream).get_cached(LISTING) is UPSTREAM_NOT_FOUND


async def test_features_not_yet_delivered_are_missing_but_not_remembered(upstream, fake_redis, client):
    """地物は配信されるまで404が返るので、覚えると配信された後も「無い」を返し続ける。"""
    upstream.get(f"/{FEATURES}").respond(404)

    assert await client(upstream).fetch(FEATURES) is UPSTREAM_NOT_FOUND

    assert await client(upstream).get_cached(FEATURES) is None


async def test_an_upstream_failure_reads_as_nothing_and_is_not_remembered(monkeypatch, upstream, fake_redis, client):
    recorded = record_external_calls(monkeypatch, jma_tile_client)
    upstream.get(f"/{TILE}").return_value = httpx.Response(503)

    assert await client(upstream).fetch(TILE) is None

    assert recorded[0].fields["result"] == "error"
    assert await client(upstream).get_cached(TILE) is None


async def test_upstream_requests_are_spaced_by_the_configured_rate_only_until_the_interval_has_passed(
    monkeypatch, upstream, fake_redis, waits, clock, client
):
    """プリウォームと利用者の取得のどちらも、プロセス全体で秒間の上限を守る（使い捨てのクライアントをまたぐ）。"""
    monkeypatch.setattr(jma_tile_client.settings, "jma_tile_upstream_max_requests_per_second", 4.0)
    upstream.get(f"/{TILE}").respond(content=OPAQUE, content_type="image/png")
    await client(upstream).fetch(TILE)

    clock.tick(0.1)
    await client(upstream).fetch(TILE)
    clock.tick(0.25)
    await client(upstream).fetch(TILE)

    assert waits == [pytest.approx(0.15)]


async def test_get_serves_the_cache_without_counting_toward_the_interval(upstream, fake_redis, waits, client):
    await client(upstream).store(TILE, OPAQUE, "image/png")
    upstream.get(f"/{OTHER_TILE}").respond(content=OPAQUE, content_type="image/png")

    assert await client(upstream).get(TILE) == (OPAQUE, "image/png")
    await client(upstream).get(OTHER_TILE)

    assert waits == []


async def test_a_time_listing_reads_as_its_frames_and_the_elements_with_tiles(upstream, fake_redis, client):
    """系列を持たない系統（nowc）の行には`member`が無く、タイルのパスでは"none"と書く。"""
    upstream.get(f"/{LISTING}").respond(
        json=[
            {"basetime": "20260101000000", "validtime": "20260101000500", "elements": ["hrpns", "hrpns_nd"]},
            {"basetime": "20260101000000", "member": "immed0", "validtime": "20260101001000"},
            {"basetime": "20260101000000"},
            {"validtime": "20260101000000"},
            "not a row",
        ]
    )

    rows = await jma_tile_client.get_target_times(client(upstream), LISTING)

    assert rows == [
        TargetTimesRow(JmaFrame("20260101000000", "none", "20260101000500"), ("hrpns", "hrpns_nd")),
        TargetTimesRow(JmaFrame("20260101000000", "immed0", "20260101001000"), ()),
    ]


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(200, text="<html>maintenance</html>"),
        httpx.Response(200, json={"basetime": "20260101000000", "validtime": "20260101000000"}),
        httpx.Response(404),
        httpx.Response(500),
    ],
    ids=["not_json", "not_a_list", "missing", "failed"],
)
async def test_a_time_listing_that_cannot_be_read_reads_as_nothing(upstream, fake_redis, answer, client):
    upstream.get(f"/{LISTING}").return_value = answer

    assert await jma_tile_client.get_target_times(client(upstream), LISTING) is None
