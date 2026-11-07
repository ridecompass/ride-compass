"""`infrastructure/job_registry.py`——プロセス内のジョブ台帳が、終わったジョブを保持時間だけ引かせ、過ぎたら掃除すること。

台帳はプロセス大域にあり、前のテストのジョブが残っていてもよい（どのテストも自分の作ったジョブだけを引く）。
時計は`clock`で進める。

ここで見ないもの:
- 状態を進めること（値を入れるだけ）と、それがポーリングの応答（待ち・結果・失敗・404）へどう出るか → `test_routes_generate.py`
"""

import pytest

from app.infrastructure import job_registry
from app.infrastructure.job_registry import JOB_TTL_SECONDS


@pytest.mark.parametrize(
    "finish",
    [
        lambda job_id: job_registry.set_done(job_id, "result"),
        lambda job_id: job_registry.set_failed(job_id, "reason"),
    ],
    ids=["done", "failed"],
)
def test_a_finished_job_can_be_polled_for_the_whole_ttl_and_is_dropped_after_it(clock, finish):
    """保持時間は画面のポーリングの打ち切りと同じで、待っている画面が掃除済みのジョブを引かない。"""
    job_id = job_registry.create_job()
    finish(job_id)

    clock.tick(JOB_TTL_SECONDS)
    job_registry.create_job()
    assert job_registry.get_job(job_id) is not None

    clock.tick(1)
    job_registry.create_job()
    assert job_registry.get_job(job_id) is None
