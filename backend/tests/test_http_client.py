"""`infrastructure/http_client.py`——外部APIへの共有HTTPクライアント（`get_http_client`）と、上流から1件取る口（`fetch_upstream`）。

ここで見ないもの:
- クライアントを通した外部APIの呼び出し → 各クライアントのテスト（例: `test_simple_api_client.py`）。各クライアントは
  失敗を自分の記憶へ入れないことを1行で見る
- 起動時のウォームアップとシャットダウンで閉じること → `main.py`のlifespan（結線のみ）
"""

import httpx
import pytest
import respx

from app.infrastructure import http_client
from app.infrastructure.http_client import UPSTREAM_NOT_FOUND, fetch_upstream
from tests.fake_http import client_for

URL = "https://upstream.example/tile.png"


def test_one_client_is_kept_per_timeout_and_waits_that_long():
    short = http_client.get_http_client(httpx.Timeout(3.0, read=5.0))
    long = http_client.get_http_client(httpx.Timeout(3.0, read=8.0))

    assert http_client.get_http_client(httpx.Timeout(3.0, read=5.0)) is short
    assert http_client.get_http_client(15.0) is http_client.get_http_client(httpx.Timeout(15.0))
    assert long is not short
    assert (short.timeout, long.timeout) == (httpx.Timeout(3.0, read=5.0), httpx.Timeout(3.0, read=8.0))


@pytest.mark.parametrize(
    "answer, expected, result, error_type",
    [
        (httpx.Response(404), UPSTREAM_NOT_FOUND, "ok", None),
        (httpx.Response(503), None, "error", "http_503"),
        (httpx.ConnectTimeout("timed out"), None, "error", "ConnectTimeout"),
    ],
    ids=["missing", "server-error", "transport-error"],
)
async def test_an_upstream_answer_other_than_success_is_told_apart_as_missing_or_failed(
    answer, expected, result, error_type
):
    """404は配信元に無いと確かめた正常系として数え、ほかの失敗だけを失敗として集計とWARNINGへ回す。"""
    router = respx.Router()
    router.get(URL).side_effect = [answer]
    fields: dict = {}

    assert await fetch_upstream(client_for(router), URL, fields) is expected
    assert (fields["result"], fields.get("error_type")) == (result, error_type)
