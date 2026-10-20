"""ログへ出す所要時間の測り方。測り始めと測り終わりは同じ時計で読むので、どちらもここを通す。"""

import time


def start_timer() -> float:
    """所要時間を測り始める。返した値を`elapsed_ms`へ渡す。"""
    return time.monotonic()


def elapsed_ms(started: float) -> int:
    """`start_timer`から今までの所要時間（ミリ秒の整数）。"""
    return round((time.monotonic() - started) * 1000)
