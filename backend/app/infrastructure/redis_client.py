"""Redis共有クライアント（何をRedisへ置くかは .claude/rules/caching-retention.md）。

すべての用途がTTL付きキャッシュ、またはPostGIS（正本）へ即座にフォールバック可能な
cache-asideのため、Redis接続自体の障害はfail-fastさせない。
"""

import time

import redis.asyncio as redis
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff

from app.config import settings

_client: redis.Redis | None = None

# 接続確立・コマンド応答の待ち上限。既定値のままだと疎通不能時の1回の失敗検知に数秒かかる。
# Redisは常に同一ホスト（本番は`--network=host`）にあるため、正常時は決して到達しない
# 短い値へ絞れる。打ち直しも0回にする（打ち直すと失敗の検知がその回数ぶん遅れ、冷却へ入るのも遅れる）。
_CONNECT_TIMEOUT_SECONDS = 0.2
_SOCKET_TIMEOUT_SECONDS = 0.2

CIRCUIT_COOLDOWN_SECONDS = 10.0
_last_failure_at: float | None = None


def get_redis_client() -> redis.Redis:
    """共有クライアント。値は生のバイト列で読み書きし、文字列（JSON等）は使う側がその場でデコードする。

    `redis.from_url()`はURLスキーム不正（`settings.redis_url`の設定ミス）等で同期的に投げる。設定の誤りは
    キャッシュの障害ではないので、未キャッシュで進まずに表へ出す。
    """
    global _client
    if _client is None:
        _client = redis.from_url(
            settings.redis_url,
            socket_connect_timeout=_CONNECT_TIMEOUT_SECONDS,
            socket_timeout=_SOCKET_TIMEOUT_SECONDS,
            retry=Retry(NoBackoff(), 0),
        )
    return _client


async def close_redis_client() -> None:
    """閉じる。次の取得で作り直す。"""
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None


def redis_available() -> bool:
    """直近のRedis障害からクールダウン期間を過ぎているか（＝呼び出す価値があるか）を返す。"""
    if _last_failure_at is None:
        return True
    return time.monotonic() - _last_failure_at >= CIRCUIT_COOLDOWN_SECONDS


def record_redis_failure() -> None:
    global _last_failure_at
    _last_failure_at = time.monotonic()


def record_redis_success() -> None:
    global _last_failure_at
    _last_failure_at = None
