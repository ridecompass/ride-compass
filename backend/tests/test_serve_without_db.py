"""`scripts/dev_prod_data_backend.py`・`scripts/serve_without_db.py`——起こし方の入口から起こした本体が、DBを読まずに起きて、
DBを読まない口（地図の下地）を返す。

入口（`dev_prod_data_backend.py: main`）は本物を通し、最後のサーバーを回す所（uvicorn）だけを、渡されたアプリと住所を受け取る
ものに替える。受け取ったアプリを TestClient で起こし、起動の段を通す。DBは、セッションの工場を引いたら落ちるようにして見る
（本体が名前で読み込んだものと、DBの口の元の両方）。下地のスタイルは、上流へ出ずに済むよう前の世代がディスクに残した形
（`tile_cache`。置き場は`tests/conftest.py`がテストごとの一時ディレクトリへ向ける）で置く。

ここで見ないもの:
- 下地の取り次ぎの書き換えとキャッシュ → `test_basemap_client.py`
"""

import json

import pytest
from fastapi.testclient import TestClient

import dev_prod_data_backend
import serve_without_db
from app import main
from app.config import settings
from app.infrastructure import database, tile_cache


def reading_the_database():
    raise AssertionError("起動の段がDBを読んだ")


@pytest.fixture
def served(monkeypatch):
    """入口から起こしたときに、サーバーへ渡されたもの（アプリ・住所・番号）。"""
    monkeypatch.setattr(main, "get_session_factory", reading_the_database)
    monkeypatch.setattr(database, "get_session_factory", reading_the_database)
    # 入口は本体の起動の段と環境変数を書き換えるので、終わったら戻す。
    monkeypatch.setattr(main.app.router, "lifespan_context", main.app.router.lifespan_context)
    for name in ("BASEMAP_PUBLIC_BASE_URL", "CORS_ALLOWED_ORIGINS"):
        monkeypatch.setenv(name, "")
    monkeypatch.setenv("RC_LAN_HOST", "192.0.2.7")
    passed = {}
    monkeypatch.setattr(serve_without_db.uvicorn, "run", lambda app, host, port: passed.update(app=app, host=host, port=port))
    dev_prod_data_backend.main()
    return passed


def test_the_dev_backend_starts_without_reading_the_database_and_serves_the_basemap_style(served):
    upstream = {"sprite": "https://tiles.openfreemap.org/sprites/ofm_f384/ofm"}
    tile_cache.set("basemap-raw/styles/liberty", json.dumps(upstream).encode(), "application/json")

    with TestClient(served["app"]) as client:
        response = client.get("/api/basemap/styles/liberty")

    assert (served["host"], served["port"]) == ("0.0.0.0", 8000)
    assert response.status_code == 200
    assert response.json()["sprite"] == f"{settings.basemap_public_base_url}/sprites/ofm_f384/ofm"
