"""解放した割り当ての領域を OS へ返す。

glibc の割り当ては、`free` した領域をプロセスに抱えたまま OS へ返さないことがあり、抱えた分もコンテナの
退避できないメモリ（anon）に数えられる。`malloc_trim(0)` は全アリーナの、ページ単位で丸ごと空いた領域を返す
（glibc 2.8 以降の `malloc_trim(3)`）。glibc の無い環境（開発機の Windows・macOS）では何もしない。
"""

import ctypes
import logging
import sys
from collections.abc import Callable

from app.domain.stopwatch import elapsed_ms, start_timer

logger = logging.getLogger("ridecompass.heap")


def _load_malloc_trim() -> Callable[[int], int] | None:
    if not sys.platform.startswith("linux"):
        return None
    try:
        libc = ctypes.CDLL(None)
    except OSError:
        return None
    # glibc でない libc（musl 等）は名前を持たないことがある
    trim = getattr(libc, "malloc_trim", None)
    if trim is None:
        return None
    trim.argtypes = [ctypes.c_size_t]
    trim.restype = ctypes.c_int
    return trim


_malloc_trim = _load_malloc_trim()


def release_freed_heap() -> None:
    """解放した領域を OS へ返す。全アリーナの錠を順に取るので、イベントループの外（スレッド）から呼ぶ。"""
    if _malloc_trim is None:
        return
    started = start_timer()
    released = _malloc_trim(0)
    logger.info("malloc_trim released=%d ms=%d", released, elapsed_ms(started))
