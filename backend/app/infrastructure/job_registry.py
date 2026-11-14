"""汎用の非同期ジョブレジストリ（プロセス内メモリのみ）。

数十秒かかりうる処理をバックグラウンドジョブ化し、問い合わせで完了を待てるようにする（終わるまで上限つきで待って返せる）。
`result`が`Any`なのは、呼び出し元の型をこのモジュールが知らずに済ませるため（循環importの回避）。
"""

import asyncio
import time
import uuid
from dataclasses import dataclass
from typing import Any, Literal

# 完了したジョブを保持する時間。掃除は次の`create_job()`のついでに行い、定期タスクを持たない。
# ルート生成のジョブを打ち切る時間でもあり、根拠は docs/modules/backend/cross-cutting-infrastructure.md「非同期ジョブレジストリ詳細」。
JOB_TTL_SECONDS = 600.0

# 問い合わせが終わるまで待ってよい上限（秒）。生成物`route-generate-config.json`で画面が問い合わせるときの待ちとして配る。
# **動かす前に同じ節を読む**。
JOB_WAIT_MAX_SECONDS = 10


@dataclass(frozen=True)
class JobPending:
    status: Literal["queued", "running"] = "queued"


@dataclass(frozen=True)
class JobDone:
    result: Any
    finished_at: float
    status: Literal["done"] = "done"


@dataclass(frozen=True)
class JobFailed:
    error: str
    finished_at: float
    status: Literal["failed"] = "failed"


#: ジョブの状態。終わった状態だけが終わった時刻を持ち、失敗だけが理由を持つ。
JobRecord = JobPending | JobDone | JobFailed


_JOBS: dict[str, JobRecord] = {}
# まだ終わっていないジョブの、終わったときに鳴る合図。`asyncio.Event`はスレッドをまたいで鳴らせないので、
# `set_done`・`set_failed`はイベントループの上（ジョブ本体のコルーチン）から呼ぶ。
_FINISHED: dict[str, asyncio.Event] = {}


def create_job() -> str:
    """新規ジョブを"queued"状態で登録し、job_idを返す。"""
    _purge_expired()
    job_id = uuid.uuid4().hex
    _JOBS[job_id] = JobPending()
    _FINISHED[job_id] = asyncio.Event()
    return job_id


def get_job(job_id: str) -> JobRecord | None:
    return _JOBS.get(job_id)


async def wait_until_finished(job_id: str, timeout_seconds: float) -> None:
    """ジョブが終わる（完了・失敗）か`timeout_seconds`秒が過ぎるまで待つ。終わったジョブ・知らないジョブなら待たない。"""
    finished = _FINISHED.get(job_id)
    if finished is None:
        return
    try:
        await asyncio.wait_for(finished.wait(), timeout_seconds)
    except TimeoutError:
        pass


def set_running(job_id: str) -> None:
    _JOBS[job_id] = JobPending(status="running")


def set_done(job_id: str, result: Any) -> None:
    _JOBS[job_id] = JobDone(result=result, finished_at=time.monotonic())
    _announce_finished(job_id)


def set_failed(job_id: str, error: str) -> None:
    _JOBS[job_id] = JobFailed(error=error, finished_at=time.monotonic())
    _announce_finished(job_id)


def _announce_finished(job_id: str) -> None:
    finished = _FINISHED.pop(job_id, None)
    if finished is not None:
        finished.set()


def _purge_expired() -> None:
    now = time.monotonic()
    expired = [
        job_id
        for job_id, record in _JOBS.items()
        if not isinstance(record, JobPending) and now - record.finished_at > JOB_TTL_SECONDS
    ]
    for job_id in expired:
        del _JOBS[job_id]
