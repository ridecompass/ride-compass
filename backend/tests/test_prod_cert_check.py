"""`backend/scripts/prod_cert_check.py`のテスト（本番・ネットワークには触れない）。

証明書の期限を読む所（`not_after`）を差し替え、残りの日数と繋ぎ方の失敗ごとに、更新の止まりとして知らせるかを見る。
ここで見ないもの: 本番の宛先を読んで終了コードにする口（`main`）とワークフローから呼ぶ所の結線と、TLS で繋いで期限を読む所
（標準ライブラリの`ssl`がそのまま持つ）。
"""

import ssl

import pytest

from scripts import prod_cert_check as check

NOW = 1_800_000_000.0
DAY = 86400.0


def _expiring(result: float | Exception):
    def not_after(host):
        if isinstance(result, Exception):
            raise result
        return result

    return not_after


@pytest.mark.parametrize(
    ("expires", "stopped"),
    [
        # 下限ちょうどまでは、更新の試みが始まってまだ日が浅いとして通す。
        (NOW + check.MIN_DAYS_LEFT * DAY, False),
        # 下限を切ったら、更新が何日も通っていないので知らせる。
        (NOW + check.MIN_DAYS_LEFT * DAY - 60, True),
        # 切れた証明書・名前の合わない証明書は、確かめが通らないので知らせる。
        (ssl.SSLCertVerificationError("certificate has expired"), True),
        # 繋がらないときも、見張れていないので知らせる。
        (ConnectionRefusedError("refused"), True),
        (TimeoutError("timed out"), True),
    ],
)
def test_reports_a_certificate_that_is_not_renewed(monkeypatch, expires, stopped):
    monkeypatch.setattr(check, "not_after", _expiring(expires))

    assert (check.problem("https://app.invalid", NOW) is not None) == stopped
