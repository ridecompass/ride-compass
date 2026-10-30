"""GitHub Actions のランナーで動くジョブが、どれも持ち主のレーンで動くことの検査。

1つの持ち主（issue・master）が同時に動かせるジョブの数は、ジョブごとの `concurrency` の group を
「<鍵>-lane-<レーン>」にして、レーンの数までに抑えている（docs/architecture/tech-stack.md「CIの実行枠」）。
レーンを持たないジョブが1つでもあると、その数だけ持ち主の上限を超えて組織の同時の枠を取り、ほかの Pull Request の
CI が待つ。待つジョブを取り消さずに並べる `queue: max` が無いと、同じレーンで待つ2本目が1本目の待ちを取り消す。

母集団は `.github/workflows/` のワークフローのジョブのうち、自分でランナーを取るもの（`runs-on` を持つ）。
再利用のワークフローを呼ぶジョブ（`uses`）はランナーを取らず、呼ばれた側のジョブが数えられる。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

WORKFLOWS = Path(__file__).resolve().parents[3] / ".github" / "workflows"

# 1つの持ち主が同時に動かせるジョブの数。
LANES = range(6)
# 担当の実行だけが使うレーン。担当は持ち時間いっぱいまで動くので、CI のジョブと同じレーンに置くと、CI が担当の終わりまで待つ。
WORKER_LANE = 0
# 鍵。Pull Request は元のブランチ、push・定時・手の起こしは ref の名前。担当と変異テストの測りは入力の issue の作業ブランチ。
# 変異テストの定期の測りは、どの issue にも属さない専用の鍵。
KEYS = (
    "${{ github.head_ref || github.ref_name }}",
    "master",
    "orch/tasks-${{ inputs.issue }}",
    "${{ inputs.issue && format('orch/tasks-{0}', inputs.issue) || 'mutation' }}",
)
_GROUP = re.compile(r"^(?P<key>.+)-lane-(?P<lane>\d+|\$\{\{ matrix\.lane \}\})$")


def _jobs():
    for path in sorted(WORKFLOWS.glob("*.yml")):
        workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
        for name, job in workflow["jobs"].items():
            if "runs-on" in job:
                yield pytest.param(job, id=f"{path.name}:{name}")


def _lanes(job: dict, lane: str) -> list[int]:
    if lane.isdigit():
        return [int(lane)]
    return [entry.get("lane") for entry in job["strategy"]["matrix"]["include"]]


def _runs_worker(job: dict) -> bool:
    return any(str(step.get("uses", "")).startswith("anthropics/claude-code-action@") for step in job["steps"])


@pytest.mark.parametrize("job", list(_jobs()))
def test_job_runs_in_an_owner_lane(job):
    concurrency = job.get("concurrency")
    assert isinstance(concurrency, dict), "concurrency が無い（どの持ち主のレーンにも数えられない）"
    assert concurrency.get("queue") == "max", "queue: max が無い（同じレーンで待つジョブが前の待ちを取り消す）"

    group = _GROUP.match(str(concurrency.get("group")))
    assert group is not None, f"group が「<鍵>-lane-<レーン>」の形でない: {concurrency.get('group')}"
    assert group["key"] in KEYS, f"鍵が持ち主の鍵でない: {group['key']}"

    lanes = _lanes(job, group["lane"])
    assert all(lane in LANES for lane in lanes), f"レーンが 0〜{LANES[-1]} でない: {lanes}"
    if _runs_worker(job):
        assert lanes == [WORKER_LANE], "担当の実行が担当のレーンにいない"
    else:
        assert WORKER_LANE not in lanes, "担当のほかのジョブが担当のレーンにいる（担当が終わるまで待つ）"
