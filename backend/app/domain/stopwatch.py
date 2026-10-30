"""ログへ出す所要時間の測り方。測り始めと測り終わりは同じ時計で読むので、どちらもここを通す。"""

import time


def start_timer() -> float:
    """所要時間を測り始める。返した値を`elapsed_ms`へ渡す。"""
    return time.monotonic()


def elapsed_ms(started: float) -> int:
    """`start_timer`から今までの所要時間（ミリ秒の整数）。"""
    return round((time.monotonic() - started) * 1000)


def add_elapsed_ms(totals: dict[str, int], step: str, started: float) -> None:
    """段ごとの所要時間の和`totals`の`step`に、`start_timer`の`started`から今までの所要時間を足す。"""
    totals[step] = totals.get(step, 0) + elapsed_ms(started)


def steps_note(totals: dict[str, int]) -> str:
    """段ごとの所要時間の和`totals`（`add_elapsed_ms`）を、ログの行の欄（段の名前_ms=ミリ秒）にする。"""
    return " ".join(f"{step}_ms={ms}" for step, ms in totals.items())
