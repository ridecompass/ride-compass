"""`infrastructure/simple_api_client.py`——「キャッシュ参照→fetch→エラー処理→
キャッシュ書き戻し」の骨格。

ここで見ないもの:
- 上流ごとのURL・要求パラメータ・応答の読み方 → 各クライアントのテスト
  （`test_jma_warning_client.py`・`test_wbgt_client.py`）
- ログの出力先・`/api/debug/stats`の集計・失敗の記録の中身（例外の種類と文言） → `debug_log`側
  （`test_debug_log.py`）。ここでは**`fields`へ何を書くか**（キャッシュの当たり外れと、成功か失敗か）
  だけを見るため、`log_external_call`を差し替えて受け取る
"""

import asyncio

import httpx
import respx
from cachetools import TTLCache

from app.infrastructure import simple_api_client
from tests.fake_external_log import record_external_calls


def _counting_fetch(value):
    """呼ばれた回数を数えるfetch。キャッシュが効いたかは呼び出し回数でしか分からない。"""
    calls: list[int] = []

    async def fetch():
        calls.append(1)
        return value

    return fetch, calls


async def test_cache_miss_calls_fetch_and_stores_result(monkeypatch):
    recorded = record_external_calls(monkeypatch, simple_api_client)
    cache: TTLCache = TTLCache(maxsize=4, ttl=60)
    fetch, _ = _counting_fetch("v")

    assert await simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k") == "v"

    assert cache["k"] == "v"
    assert recorded[0].category == "cat"
    fields = recorded[0].fields
    assert fields["cache"] == "miss"
    assert fields["result"] == "ok"


async def test_cache_hit_skips_fetch(monkeypatch):
    recorded = record_external_calls(monkeypatch, simple_api_client)
    cache: TTLCache = TTLCache(maxsize=4, ttl=60)
    cache["k"] = "stored"
    fetch, calls = _counting_fetch("fresh")

    assert await simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k") == "stored"

    assert calls == []
    assert recorded[0].fields["cache"] == "hit"


async def test_an_upstream_answer_of_nothing_is_cached_too():
    """該当なし（None）を未取得と取り違えると、該当なしの地点のたびに上流を叩き、上流の回数の約束に当たる。"""
    cache: TTLCache = TTLCache(maxsize=4, ttl=60)
    fetch, calls = _counting_fetch(None)

    assert await simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k") is None
    assert await simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k") is None

    assert len(calls) == 1


async def test_caught_exception_returns_none_and_is_not_cached(monkeypatch):
    recorded = record_external_calls(monkeypatch, simple_api_client)
    cache: TTLCache = TTLCache(maxsize=4, ttl=60)
    calls: list[int] = []

    async def fetch():
        calls.append(1)
        raise ValueError("bad json")

    assert await simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k") is None
    assert await simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k") is None
    assert len(calls) == 2

    assert recorded[0].fields["result"] == "error"


def _held_fetch(outcome):
    """`release`が立つまで返らないfetch。先の要求が上流を待つ間に、次の要求を来させる。"""
    release = asyncio.Event()
    calls: list[int] = []

    async def fetch():
        calls.append(1)
        await release.wait()
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    return fetch, calls, release


async def test_a_dropped_request_does_not_stop_the_fetch_others_wait_for():
    """先に来た要求が切れても（利用者が画面を離れる）、同じ取得を待つ要求は値を受け、値はキャッシュへ残る。"""
    cache: TTLCache = TTLCache(maxsize=4, ttl=60)
    fetch, calls, release = _held_fetch("v")

    dropped = asyncio.ensure_future(simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k"))
    waiting = asyncio.ensure_future(simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k"))
    await asyncio.sleep(0)
    dropped.cancel()
    release.set()

    assert await waiting == "v"
    assert await simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k") == "v"
    assert len(calls) == 1


async def test_requests_waiting_for_a_failing_fetch_fail_with_it(monkeypatch):
    """同じ取得を待っていた要求も、上流へ取り直さずに同じ失敗（None）を受ける。"""
    recorded = record_external_calls(monkeypatch, simple_api_client)
    cache: TTLCache = TTLCache(maxsize=4, ttl=60)
    fetch, calls, release = _held_fetch(ValueError("bad json"))

    first = asyncio.ensure_future(simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k"))
    waiting = asyncio.ensure_future(simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k"))
    await asyncio.sleep(0)
    release.set()

    assert await asyncio.gather(first, waiting) == [None, None]
    assert len(calls) == 1
    assert [call.fields["result"] for call in recorded] == ["error", "error"]


async def test_get_json_waits_as_long_as_the_client_it_is_given():
    # 上流ごとの待ち時間は、注入するクライアントが持つ。呼び出しで上書きすると、選んだ待ち時間が効かない。
    router = respx.Router()
    route = router.get("https://example.test/a.json").respond(json={})
    client = httpx.AsyncClient(timeout=httpx.Timeout(1.0, read=7.0), transport=httpx.MockTransport(router.handler))

    assert await simple_api_client.get_json(client, "https://example.test/a.json", dict, "a is") == {}
    assert route.calls.last.request.extensions["timeout"] == client.timeout.as_dict()
