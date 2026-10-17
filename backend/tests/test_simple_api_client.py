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
import pytest
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


async def test_without_cache_calls_fetch_every_time():
    fetch, calls = _counting_fetch({"a": 1})

    assert await simple_api_client.cached_fetch("cat", fetch) == {"a": 1}
    assert await simple_api_client.cached_fetch("cat", fetch) == {"a": 1}

    assert len(calls) == 2


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


async def test_none_from_upstream_is_cached():
    """上流の「該当なし」もキャッシュする。未取得と同じ値にすると、該当なしの問い合わせが
    TTLの間ずっと上流へ流れ続ける。"""
    cache: TTLCache = TTLCache(maxsize=4, ttl=60)
    fetch, calls = _counting_fetch(None)

    assert await simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k") is None
    assert await simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k") is None

    assert len(calls) == 1


async def _unexpected_shape():
    raise simple_api_client.UnexpectedShapeError("list, not dict")


async def test_unexpected_shape_is_swallowed_even_when_catch_is_empty():
    """`UnexpectedShapeError`は`catch`の指定に関わらず常にNoneへ倒れる。"""
    assert await simple_api_client.cached_fetch("cat", _unexpected_shape, catch=()) is None


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


async def test_exception_outside_catch_propagates():
    async def fetch():
        raise httpx.ConnectError("boom")

    with pytest.raises(httpx.ConnectError):
        await simple_api_client.cached_fetch("cat", fetch, catch=(KeyError,))


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


@pytest.mark.parametrize(("outcome", "expected"), [("v", "v"), (ValueError("bad json"), None)])
async def test_requests_for_a_key_being_fetched_share_that_fetch(outcome, expected):
    """同じ鍵に同時に来た要求は、上流へ1回だけ取りに行き、その結果（失敗も）を分け合う。"""
    cache: TTLCache = TTLCache(maxsize=4, ttl=60)
    fetch, calls, release = _held_fetch(outcome)

    requests = [asyncio.ensure_future(simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k")) for _ in range(2)]
    await asyncio.sleep(0)
    release.set()

    assert await asyncio.gather(*requests) == [expected, expected]
    assert len(calls) == 1


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
