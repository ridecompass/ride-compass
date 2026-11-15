"""Redis共有クライアント（何をRedisへ置くかは .claude/rules/caching-retention.md）。"""

import redis.asyncio as redis

from app.config import settings

_client: redis.Redis | None = None


def get_redis_client() -> redis.Redis:
    """共有クライアント。値は生のバイト列で読み書きし、文字列（JSON等）は使う側がその場でデコードする。"""
    global _client
    if _client is None:
        _client = redis.from_url(settings.redis_url)
    return _client


async def close_redis_client() -> None:
    """閉じる。次の取得で作り直す。"""
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None
