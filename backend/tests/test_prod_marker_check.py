"""`backend/scripts/prod_marker_check.py`のテスト（本番・ネットワークには触れない）。

網（`urllib.request.urlopen`）を差し替え、`/health`の応答ごとに止まりとして知らせるかを見る。
ここで見ないもの: 本番の宛先を読んで終了コードにする口（`main`）とワークフローから呼ぶ所の結線と、
`/health`が経過時間を作る所（`test_health.py`）。
"""

import io
import json
import urllib.error
import urllib.request

import pytest

from scripts import prod_marker_check as check
from tests.bound_fake import bound


def _answering(body: bytes | Exception):
    def urlopen(url, data=None, timeout=None, *, context=None):
        if isinstance(body, Exception):
            raise body
        return io.BytesIO(body)

    return bound(urllib.request.urlopen, urlopen)


def _health(**ages: float | None) -> bytes:
    return json.dumps({"status": "ok", **ages}).encode()


BACKUP = "admin_data_backup_age_hours"
REFRESH = "source_refresh_age_hours"
LIMIT = check.MAX_AGE_HOURS


@pytest.mark.parametrize(
    ("field", "answer", "stopped"),
    [
        # 上限ちょうどまでは、定期の回が少し遅れただけとして通す。
        (BACKUP, _health(**{BACKUP: LIMIT[BACKUP]}), False),
        (REFRESH, _health(**{REFRESH: LIMIT[REFRESH]}), False),
        # 上限を超えたら、通らなかった回があるので知らせる。見るのは指定した欄だけで、ほかの仕組みの時刻では通さない。
        (BACKUP, _health(**{BACKUP: LIMIT[BACKUP] + 0.1, REFRESH: 0.0}), True),
        (REFRESH, _health(**{BACKUP: 0.0, REFRESH: LIMIT[REFRESH] + 0.1}), True),
        # 一度も通っていない・印が読めないときも、止まりと区別できないので知らせる。
        (REFRESH, _health(**{REFRESH: None}), True),
        # backendが応答しない・形の違う応答も、見張れていないので知らせる。
        (BACKUP, urllib.error.URLError("refused"), True),
        (BACKUP, b"<html>502</html>", True),
    ],
)
def test_reports_a_stopped_host_job(monkeypatch, field, answer, stopped):
    monkeypatch.setattr(urllib.request, "urlopen", _answering(answer))

    assert (check.problem("https://backend.invalid", field) is not None) == stopped
