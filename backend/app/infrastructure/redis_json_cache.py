"""Redisへ持つcache-asideの共通骨格（JSON・生のバイト列・Hash）。

呼び出し元が持つのはキー設計・TTL・値の意味づけだけで、`log_external_call`での計測はここが引き受ける。
"""

import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, cast

import redis.asyncio as redis

from app.infrastructure.debug_log import log_external_call
from app.infrastructure.redis_client import get_redis_client


async def _get(
    read: Callable[[redis.Redis], Awaitable[Any]],
    decode: Callable[[Any], Any | None],
    category: str,
    log_fields: dict[str, Any],
) -> Any | None:
    """`read`は保存が無ければNoneを返す。`decode`がNoneを返したエントリ（壊れた・形の違う値）は未キャッシュ扱いにし、
    missとして記録する。"""
    with log_external_call(category, **log_fields) as fields:
        raw = await read(get_redis_client())
        value = None if raw is None else decode(raw)
        fields["cache"] = "hit" if value is not None else "miss"
        return value


async def _set(
    write: Callable[[redis.Redis], Awaitable[Any]],
    category: str,
    log_fields: dict[str, Any],
) -> None:
    with log_external_call(category, **log_fields):
        await write(get_redis_client())


async def get_json(key: str, *, category: str, **log_fields: Any) -> Any | None:
    """キーに対応するJSONを返す。未保存・壊れたエントリはNone。

    `category`は`log_external_call`のカテゴリ（`/api/debug/stats`の集計単位）。
    """
    return await get_bytes(key, decode=_json_or_none, category=category, **log_fields)


def _json_or_none(raw: bytes) -> Any | None:
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


async def set_json(key: str, value: Any, *, ttl_seconds: int, category: str, **log_fields: Any) -> None:
    """値をJSONで保存する。"""
    await set_bytes(key, json.dumps(value).encode(), ttl_seconds=ttl_seconds, category=category, **log_fields)


async def get_bytes(
    key: str, *, decode: Callable[[bytes], Any | None], category: str, **log_fields: Any
) -> Any | None:
    """キーに対応するバイト列を文字列へデコードせずに`decode`へ渡し、その結果を返す。
    未保存・`decode`がNoneを返したエントリはNone。"""
    return await _get(lambda client: client.get(key), decode, category, log_fields)


async def set_bytes(key: str, value: bytes, *, ttl_seconds: int, category: str, **log_fields: Any) -> None:
    """バイト列をそのまま保存する。"""
    await _set(lambda client: client.set(key, value, ex=ttl_seconds), category, log_fields)


async def get_hash(
    key: str, *, decode: Callable[[dict[bytes, bytes]], Any | None], category: str, **log_fields: Any
) -> Any | None:
    """キーのHashの全項目（項目名・値ともバイト列）を`decode`へ渡し、その結果を返す。
    未保存・`decode`がNoneを返したエントリはNone。"""

    async def read(client: redis.Redis) -> dict[bytes, bytes] | None:
        # redis-pyは同期・非同期のクライアントで型を共有し、戻り値を`Awaitable[X] | X`と宣言している。
        fields = await cast(Awaitable[dict[bytes, bytes]], client.hgetall(key))
        return fields or None

    return await _get(read, decode, category, log_fields)


async def set_hashes(hashes: Mapping[str, Mapping[str, str]], *, ttl_seconds: int, category: str) -> None:
    """キーごとのHashを、TTLとともに1往復（pipeline）で書く。"""

    async def write(client: redis.Redis) -> None:
        pipe = client.pipeline(transaction=False)
        for key, mapping in hashes.items():
            # `dict(mapping)`だと`dict[str, str]`になり、`hset`が宣言する項目名の広い型（`FieldT`）へ渡せない。
            pipe.hset(key, mapping={field: value for field, value in mapping.items()})
            pipe.expire(key, ttl_seconds)
        await pipe.execute()

    await _set(write, category, {})
