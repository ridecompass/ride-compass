"""`backend/scripts/prod_msm_check.py`のテスト（本番・ネットワークには触れない）。

網（`urllib.request.urlopen`）を差し替え、`/api/debug/stats`の応答ごとに予報の鮮度の落ちとして知らせるかを見る。
ここで見ないもの: 本番の宛先を読んで終了コードにする口（`main`）とワークフローから呼ぶ所の結線と、
`msm`の値を作る所（`healthy`の判定は`test_msm_client.py`）。
"""

import io
import json
import urllib.error
import urllib.request

import pytest

from scripts import prod_msm_check as check
from tests.bound_fake import bound


def _answering(body: bytes | Exception):
    def urlopen(url, data=None, timeout=None, *, context=None):
        if isinstance(body, Exception):
            raise body
        return io.BytesIO(body)

    return bound(urllib.request.urlopen, urlopen)


def _stats(healthy: bool | None) -> bytes:
    msm = None if healthy is None else {
        "last_run_at": "2026-11-08T03:00:00+09:00",
        "run_age_hours": 5.0,
        "remaining_hours": 30.0,
        "healthy": healthy,
    }
    return json.dumps({"commit": None, "msm": msm}).encode()


@pytest.mark.parametrize(
    ("answer", "stale"),
    [
        (_stats(True), False),
        # 新しいrunが来ない・予報が尽きかけているとbackendが判定したら知らせる。
        (_stats(False), True),
        # メタ情報が無い・読めないときも、止まりと区別できないので知らせる。
        (_stats(None), True),
        # backendが応答しない・形の違う応答も、見張れていないので知らせる。
        (urllib.error.URLError("refused"), True),
        (b"<html>502</html>", True),
    ],
)
def test_reports_a_stale_forecast(monkeypatch, answer, stale):
    monkeypatch.setattr(urllib.request, "urlopen", _answering(answer))

    assert (check.problem("https://backend.invalid") is not None) == stale
