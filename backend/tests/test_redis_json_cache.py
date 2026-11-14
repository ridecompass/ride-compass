"""`infrastructure/redis_json_cache.py`——Redisへ持つcache-asideの骨格（JSON・生のバイト列・Hash）。

入口は`get_json`・`set_json`・`get_bytes`・`set_bytes`・`get_hash`・`set_hashes`。Redisはfakeredis、時計はfreezegunで与え、
キャッシュの当たり外れは`/api/debug/stats`の集計（`debug_log.py: get_stats`）で見る。

ここで見ないもの:
- 骨格を写さずにここを通しているか → `tests/structure/test_redis_skeleton.py`
- キー設計・TTL・値の意味づけ → 呼び出し元のテスト（例: `test_jma_tile_redis_cache.py`）
"""

import pytest

from app.infrastructure import redis_json_cache
from app.infrastructure.debug_log import get_stats

KEY = "sample:key"
TTL = 60


@pytest.fixture
def category(request) -> str:
    """このテストだけの集計のカテゴリ。集計はプロセスの寿命の間に足されるだけなので、前のテストの数と混ざらない
    名前で始める。"""
    return f"sample_cache:{request.node.name}"


def stats(category: str):
    return get_stats().external[category]


async def test_a_stored_json_value_comes_back_and_counts_as_a_hit(category, fake_redis):
    value = {"name": "観測所", "values": [1, 2.5, None], "nested": {"ok": True}}

    await redis_json_cache.set_json(KEY, value, ttl_seconds=TTL, category=category)

    assert await redis_json_cache.get_json(KEY, category=category) == value
    assert stats(category).cache_hits == 1
    # TTLの無いキーはRedisの退避の対象にならず、上限に達すると書き込みが失敗する
    assert await fake_redis.ttl(KEY) == TTL
    assert stats(category).errors == 0


async def test_hashes_written_together_come_back_one_by_one_with_their_ttl(category, fake_redis):
    """観測所ごとのHashを1往復でまとめて書き、1つずつ読む。TTLが付かないと、バッチが止まっても古い観測値が残り続ける。"""
    await redis_json_cache.set_hashes(
        {"sample:a": {"temp": "20.5", "wind": ""}, "sample:b": {"temp": "3"}}, ttl_seconds=TTL, category=category
    )

    assert await redis_json_cache.get_hash("sample:a", decode=dict, category=category) == {
        b"temp": b"20.5",
        b"wind": b"",
    }
    assert [await fake_redis.ttl(key) for key in ("sample:a", "sample:b")] == [TTL, TTL]
    assert stats(category).cache_hits == 1


async def test_a_hash_never_stored_does_not_reach_the_decoder(category, fake_redis):
    def decode(fields: dict) -> dict:
        raise AssertionError("未保存のキーで解釈関数が呼ばれた")

    assert await redis_json_cache.get_hash("sample:a", decode=decode, category=category) is None
    assert stats(category).cache_misses == 1
