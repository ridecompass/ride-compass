"""`infrastructure/http_client.py`——上流から1件取る口（`fetch_upstream`）。

ここで見ないもの:
- クライアントを通した外部APIの呼び出し → 各クライアントのテスト（例: `test_simple_api_client.py`）。各クライアントは
  失敗を自分の記憶へ入れないことを1行で見る
- シャットダウンで閉じること → `main.py`のlifespan（結線のみ）
"""

import httpx
import respx

from app.infrastructure.http_client import UPSTREAM_NOT_FOUND, fetch_upstream
from tests.fake_http import client_for

URL = "https://upstream.example/tile.png"


async def test_a_missing_upstream_answer_is_told_apart_as_nothing_to_get():
    """404は配信元に無いと確かめた正常系として返し、成功として数える（ほかの失敗は投げる）。"""
    router = respx.Router()
    router.get(URL).side_effect = [httpx.Response(404)]
    fields: dict = {}

    assert await fetch_upstream(client_for(router), URL, fields) is UPSTREAM_NOT_FOUND
    assert fields == {"status": 404, "result": "ok"}
