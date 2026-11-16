"""ルート生成の同時実行の枠と、枠を待つ待ち行列。"""

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any


class GenerationSlots:
    """同時に走る生成を`running`件までに絞り、超えた分を`queued`件まで受け付けた順に待たせる。"""

    def __init__(self, running: int, queued: int) -> None:
        # `asyncio.Semaphore`は待つ順に起こすので、待ちは受け付けた順に枠を取る。
        self._semaphore = asyncio.Semaphore(running)
        self._capacity = running + queued
        # 受け付けて終わっていないジョブ。イベントループはタスクへの強参照を持たないため、ここで保持しないとGCが
        # 実行中のジョブごと回収しうる。
        self._jobs: set[asyncio.Task] = set()

    def full(self) -> bool:
        """走る分と待つ分を合わせた数が上限に達しているか。

        受け付けを決める側は、これを見てから`start`するまでにawaitを挟まない（挟むと、ほぼ同時に届いた要求が上限を
        超えて受理される）。"""
        return len(self._jobs) >= self._capacity

    def start(self, job: Callable[[], Coroutine[Any, Any, None]]) -> None:
        """`job`を呼んで起動し、終わるまで受け付けの数に数える。"""
        task = asyncio.create_task(job())
        self._jobs.add(task)
        task.add_done_callback(self._jobs.discard)

    async def acquire(self, wait_seconds: float) -> bool:
        """枠を取る。`wait_seconds`のうちに空かなければFalse。取れたら、成否によらず`release`で必ず返す。"""
        try:
            async with asyncio.timeout(wait_seconds):
                await self._semaphore.acquire()
        except TimeoutError:
            return False
        return True

    def release(self) -> None:
        self._semaphore.release()
