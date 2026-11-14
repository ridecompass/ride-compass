"""`infrastructure/simple_api_client.py`——「キャッシュ参照→fetch→エラー処理→
キャッシュ書き戻し」の骨格。

ここで見ないもの:
- 上流ごとのURL・要求パラメータ・応答の読み方 → 各クライアントのテスト
  （`test_jma_warning_client.py`・`test_wbgt_client.py`）
- ログの出力先・`/api/debug/stats`の集計・失敗の記録の中身（例外の種類と文言） → `debug_log`側
  （`test_debug_log.py`）。ここでは**`fields`へ何を書くか**（キャッシュの当たり外れと、成功か失敗か）
  だけを見るため、`log_external_call`を差し替えて受け取る
"""

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


async def test_cache_miss_calls_fetch_and_stores_result(monkeypatch):
    recorded = record_external_calls(monkeypatch, simple_api_client)
    cache: TTLCache = TTLCache(maxsize=4, ttl=60)
    fetch, _ = _counting_fetch("v")

    assert await simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k") == "v"

    assert cache["k"] == "v"
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


async def test_a_reading_that_trips_on_the_shape_fails_as_a_shape_error(monkeypatch):
    """読み方が項目の欠け・型の違いでつまずいたら、配信の形の誤りとして投げる（口はそれを502にする）。"""
    recorded = record_external_calls(monkeypatch, simple_api_client)
    cache: TTLCache = TTLCache(maxsize=4, ttl=60)

    async def fetch():
        raise ValueError("bad json")

    with pytest.raises(simple_api_client.UnexpectedShapeError, match=r"cat: ValueError\('bad json'\)"):
        await simple_api_client.cached_fetch("cat", fetch, cache=cache, key="k")

    assert [call.fields["error_type"] for call in recorded] == ["UnexpectedShapeError"]
    assert "k" not in cache
