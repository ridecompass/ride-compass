"""`infrastructure/response_compression.py`——content-typeで対象を絞った応答のgzip圧縮（`ContentTypeGZipMiddleware`）。

応答の形（content-type・大きさ）を自由に作れるよう、ASGIのアプリを手で書いて包む。

ここで見ないもの:
- ミドルウェアの登録の順 → `main.py`（結線のみ）
- 圧縮する最小の大きさ・分けて送る応答の圧縮。Starletteの`GZipMiddleware`がそのまま持つ
- 圧縮の強さ（`compresslevel`）。縮み方と所要時間の兼ね合いで、応答の中身には現れない
"""

import gzip

import pytest
from starlette.testclient import TestClient

from app.infrastructure.response_compression import DEFAULT_MINIMUM_SIZE, ContentTypeGZipMiddleware

LARGE_BODY = b"x" * DEFAULT_MINIMUM_SIZE


def app_answering(content_type: str | None):
    """`content_type`（Noneなら付けない）で`LARGE_BODY`を送るアプリ。"""

    async def app(scope, receive, send):
        headers = [] if content_type is None else [(b"content-type", content_type.encode())]
        await send({"type": "http.response.start", "status": 200, "headers": headers})
        await send({"type": "http.response.body", "body": LARGE_BODY})

    return app


def fetch(content_type: str | None, accept_encoding: str = "gzip, deflate, br"):
    client = TestClient(ContentTypeGZipMiddleware(app_answering(content_type)))
    # TestClient（httpx）は受け取ったgzipを自分で解くので、届いた生のバイト列を読む。
    with client.stream("GET", "/", headers={"Accept-Encoding": accept_encoding}) as response:
        return response, b"".join(response.iter_raw())


@pytest.mark.parametrize(
    "content_type",
    [
        "application/json",
        "application/json; charset=utf-8",
        "Application/JSON",
        "text/csv",
    ],
)
def test_a_large_compressible_response_is_gzipped(content_type):
    response, raw = fetch(content_type)

    assert response.headers["content-encoding"] == "gzip"
    assert gzip.decompress(raw) == LARGE_BODY


@pytest.mark.parametrize("content_type", ["image/png", None])
def test_a_response_that_is_not_compressible_passes_through_unchanged(content_type):
    """ラスタのタイルは圧縮済みで、gzipしても縮まずCPUだけを使う。"""
    response, raw = fetch(content_type)

    assert "content-encoding" not in response.headers
    assert raw == LARGE_BODY
