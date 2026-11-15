"""Pythonオブジェクトを、呼び出し元が設計したタプルの鍵でディスクへ永続化する汎用キャッシュ
（保持層の選び方は .claude/rules/caching.md、無効化の方針は .claude/rules/caching-retention.md）。

保存の実体は`diskcache`（SQLite＋ファイル）で、32KBを超える値はライブラリがファイルへ、
以下はSQLite内へ格納する。シリアライズはpickle（`diskcache`の既定）。

世代・失効は鍵と`expire`で呼び出し側が表す。容量上限を超えればライブラリが古いものから退避する。
"""

import asyncio
import logging
import time
from typing import Any

import diskcache

from app.config import settings
from app.infrastructure.data_paths import DATA_DIR
from app.infrastructure.tile_cache import DISK_READ_ERRORS, DISK_STORE_ERRORS

logger = logging.getLogger("ridecompass.tile_persistent_cache")

CACHE_DIR = DATA_DIR / "tile_persistent_cache"

# タイルの値は、焼く中身を変えた側が捨てる（`region_tile_cache.py: discard_region_tiles`）ので鮮度の制約が無い。
# 失っても読み直すだけのものとして長く持ち、DBへの再問い合わせを抑える。
_TILE_ENTRY_TTL_SECONDS = 24 * 3600

_opened_cache: diskcache.Cache | None = None


def cache() -> diskcache.Cache:
    """遅延生成した共有キャッシュ。同じディレクトリを複数プロセスから開いてよい。"""
    global _opened_cache
    if _opened_cache is None:
        _opened_cache = diskcache.Cache(
            str(CACHE_DIR),
            size_limit=settings.tile_persistent_cache_size_limit_mb * 1024 * 1024,
            eviction_policy="least-recently-used",
            # 設定は置き場に保存され、渡さなければ前に開いたときの値を引き継ぐ。明示しないと、
            # 以前張ったタグの索引が書き込みのたびに更新され続ける。
            tag_index=False,
        )
    return _opened_cache


def close() -> None:
    """開いたキャッシュを閉じる。次の読み書きで開き直す。"""
    global _opened_cache
    if _opened_cache is not None:
        _opened_cache.close()
        _opened_cache = None


def get_by_key(key: tuple) -> Any | None:
    """任意のタプルキーで読む。キーの設計は呼び出し元が持つ（先頭要素をnamespaceにする）。
    未キャッシュ・破損時はNone。"""
    try:
        started = time.monotonic()
        value = cache().get(key)
        read_ms = (time.monotonic() - started) * 1000
    except DISK_READ_ERRORS as exc:  # 破損エントリ・SQLite障害はいずれも未キャッシュ扱いにする
        logger.warning("tile persistent cache read failed key=%r, treating as cache miss error=%r", key, exc)
        return None
    if value is not None:
        logger.debug("tile persistent cache hit key=%r read_ms=%.1f", key, read_ms)
    return value


def set_by_key(key: tuple, value: Any, *, expire: float) -> None:
    """任意のタプルキーで書き、`expire`（秒）で失効させる。

    置き場の障害（ディスクフル等）で書けなければ、警告ログを出して書かずに進む（キャッシュに書けないことが応答を
    止める理由にはならない）。pickleにできない値は実装の誤りなので投げる。
    """
    try:
        cache().set(key, value, expire=expire)
    except DISK_STORE_ERRORS as exc:  # 置き場の障害は、書かずに進む
        logger.warning("tile persistent cache write failed key=%r error=%r", key, exc)


def delete_namespace(namespace: str) -> None:
    """先頭の要素が`namespace`の鍵を全部消す。

    鍵を全部読み終えてから消す（読みながら消すと、読み進める位置が消した分だけずれる）。置き場の障害は警告だけにする——
    消せなければ失効か容量の上限が退避するまで残るだけで、配信は止めない。
    """
    try:
        stale = [key for key in cache().iterkeys() if isinstance(key, tuple) and key[:1] == (namespace,)]
        for key in stale:
            cache().delete(key)
    except DISK_STORE_ERRORS as exc:  # 置き場の障害は、消さずに残すことへ倒す
        logger.warning("tile persistent cache delete failed namespace=%s error=%r", namespace, exc)


async def get_tile_entry(key: tuple) -> Any | None:
    """`set_tile_entry`で書いた値を読む。"""
    return await asyncio.to_thread(get_by_key, key)


async def set_tile_entry(key: tuple, value: Any) -> None:
    """タイルの値を書く（失効は`_TILE_ENTRY_TTL_SECONDS`）。"""
    await asyncio.to_thread(set_by_key, key, value, expire=_TILE_ENTRY_TTL_SECONDS)
