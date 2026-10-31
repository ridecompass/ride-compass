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
from app.infrastructure.cache_identity import is_known_tile_version
from app.infrastructure.data_paths import DATA_DIR
from app.infrastructure.debug_log import log_throttled_warning

logger = logging.getLogger("ridecompass.tile_persistent_cache")

CACHE_DIR = DATA_DIR / "tile_persistent_cache"

_CATEGORY = "cache:tile-persistent"

# 路面タイルの世代を鍵に持つ値は、派生の表と生データが変われば世代ごと読まれなくなる。鮮度の制約が無いので、
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
    except Exception as exc:  # 破損エントリ・SQLite障害はいずれも未キャッシュ扱いにする
        log_throttled_warning(
            _CATEGORY, "tile persistent cache read failed key=%r, treating as cache miss error=%r", key, exc
        )
        return None
    if value is not None:
        logger.debug("tile persistent cache hit key=%r read_ms=%.1f", key, read_ms)
    return value


def set_by_key(key: tuple, value: Any, *, expire: float) -> None:
    """任意のタプルキーで書き、`expire`（秒）で失効させる。

    書き込み失敗（ディスクフル・pickle化不能な値等）は握りつぶし、警告ログのみで
    no-opにフォールバックする（キャッシュ書き込みの失敗が応答を止める理由にはならない）。
    """
    try:
        cache().set(key, value, expire=expire)
    except Exception as exc:  # OSError（ディスクフル）・pickle化不能のいずれも吸収する
        log_throttled_warning(_CATEGORY, "tile persistent cache write failed key=%r error=%r", key, exc)



async def get_tile_entry(key: tuple) -> Any | None:
    """`set_tile_entry`で書いた値を読む。"""
    return await asyncio.to_thread(get_by_key, key)


async def set_tile_entry(key: tuple, value: Any, *, surface_tile_version: str) -> None:
    """路面タイルの世代（`surface_tile_version`。鍵にも入れる）に結んだ値を書く。世代を読めていない
    （`cache_identity.py: is_known_tile_version`が偽）ときは書かない——どの世代の鍵の値か分からないまま残すと、
    後で同じ印の鍵で別の世代の値を返す。"""
    if is_known_tile_version(surface_tile_version):
        await asyncio.to_thread(set_by_key, key, value, expire=_TILE_ENTRY_TTL_SECONDS)
