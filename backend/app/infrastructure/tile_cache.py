"""取得・生成したタイル・フォント等の生バイトを、配信パスを鍵にディスクへ置く
（保持層の選び方・容量の持ち方は .claude/rules/caching.md）。

保存の実体は`diskcache`で、容量上限を超えればライブラリが書き込みのついでに退避する。
"""

from collections.abc import Callable

import diskcache

from app.config import settings
from app.infrastructure.data_paths import DATA_DIR

CACHE_DIR = DATA_DIR / "tile_cache"

_opened_cache: diskcache.Cache | None = None


def _opened() -> diskcache.Cache:
    """遅延生成した共有キャッシュ。スレッド（`asyncio.to_thread`）から同時に呼んでよい。"""
    global _opened_cache
    if _opened_cache is None:
        _opened_cache = diskcache.Cache(
            str(CACHE_DIR),
            size_limit=settings.tile_cache_size_limit_mb * 1024 * 1024,
            # 退避の順は書いた順にする。読んだ順（least-recently-used）は読むたびに書き込みが走り、
            # 地図の読み込みで同時に来る数十件のタイル要求がそのぶん重くなる。
            eviction_policy="least-recently-stored",
        )
    return _opened_cache


def get(path: str) -> tuple[bytes, str] | None:
    """キャッシュ済みなら(内容, Content-Type)を返す。未キャッシュならNone（呼び出し元が取り直す）。"""
    return _opened().get(path)


def set(path: str, content: bytes, content_type: str) -> None:
    _opened().set(path, (content, content_type))


def delete_where(is_stale: Callable[[str], bool]) -> int:
    """`is_stale`が真を返す鍵を消し、消した数を返す。容量の上限とは別に、世代交代で読まれなくなった実体を消す口。

    鍵を全部読み終えてから消す（読みながら消すと、読み進める位置が消した分だけずれる）。
    """
    cache = _opened()
    stale = [key for key in cache.iterkeys() if is_stale(key)]
    return sum(1 for key in stale if cache.delete(key))


def clear_all() -> None:
    _opened().clear()


def close() -> None:
    """開いたキャッシュを閉じる。次の読み書きで開き直す。"""
    global _opened_cache
    if _opened_cache is not None:
        _opened_cache.close()
        _opened_cache = None
