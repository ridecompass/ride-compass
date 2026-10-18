"""`api/routers/basemap.py`——基礎地図の中継と、タイルのファイルキャッシュの全消去。

確かめるのは、取得の結果（中身・配信元に無い・失敗）がどの応答になるか。
取得の口（`get_basemap_client`）は応答を差し替える。

ここで見ないもの:
- 配信元への取得・キャッシュの読み書き・「配信元に無い」の見分け → `test_basemap_client.py`
- 回数制限の数え方そのもの → `test_rate_limiter.py`
- 管理の口の認証 → `test_admin_route_authorization.py`
"""

import pytest
from fastapi.testclient import TestClient

from app.api.dependencies import get_basemap_client
from app.infrastructure.http_client import UPSTREAM_NOT_FOUND
from app.main import app

client = TestClient(app)


class FakeBasemapClient:
    def __init__(self, result):
        self._result = result

    async def get(self, path):
        return self._result


def _answer(monkeypatch, result):
    monkeypatch.setitem(app.dependency_overrides, get_basemap_client, lambda: FakeBasemapClient(result))


@pytest.mark.parametrize(("result", "status", "detail"), [
    (None, 502, "地図タイルの取得に失敗しました"),
    # 配信元に無い部品は上流障害ではない。502で返すと、本当の障害が埋もれる。
    (UPSTREAM_NOT_FOUND, 404, "指定されたリソースは存在しません"),
])
def test_basemap_proxy_tells_a_missing_part_apart_from_an_upstream_failure(monkeypatch, result, status, detail):
    _answer(monkeypatch, result)

    response = client.get("/api/basemap/fonts/NotoSans/40000-40255.pbf")

    assert response.status_code == status
    assert response.json() == {"detail": detail}
    # 部品の404をブラウザに覚えさせない。
    assert "cache-control" not in response.headers
