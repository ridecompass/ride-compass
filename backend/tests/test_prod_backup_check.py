"""`backend/scripts/prod_backup_check.py`のテスト（本番・ネットワークには触れない）。

網（`urllib.request.urlopen`）を差し替え、`/health`の応答ごとに止まりとして知らせるかを見る。
ここで見ないもの: 本番の宛先を読んで終了コードにする口（`main`）とワークフローから呼ぶ所の結線と、
`/health`が経過時間を作る所（`test_health.py`）。
"""

import io
import json
import urllib.error
import urllib.request

import pytest

from scripts import prod_backup_check as check
from tests.bound_fake import bound


def _answering(body: bytes | Exception):
    def urlopen(url, data=None, timeout=None, *, context=None):
        if isinstance(body, Exception):
            raise body
        return io.BytesIO(body)

    return bound(urllib.request.urlopen, urlopen)


def _health(age: float | None) -> bytes:
    return json.dumps({"status": "ok", "admin_data_backup_age_hours": age}).encode()


@pytest.mark.parametrize(
    ("answer", "stopped"),
    [
        # 上限ちょうどまでは、毎日の回が少し遅れただけとして通す。
        (_health(check.MAX_AGE_HOURS), False),
        # 上限を超えたら、置けなかった回があるので知らせる。
        (_health(check.MAX_AGE_HOURS + 0.1), True),
        # 一度も置けていない・印が読めないときも、止まりと区別できないので知らせる。
        (_health(None), True),
        # backendが応答しない・形の違う応答も、見張れていないので知らせる。
        (urllib.error.URLError("refused"), True),
        (b"<html>502</html>", True),
    ],
)
def test_reports_a_stopped_backup(monkeypatch, answer, stopped):
    monkeypatch.setattr(urllib.request, "urlopen", _answering(answer))

    assert (check.problem("https://backend.invalid") is not None) == stopped
