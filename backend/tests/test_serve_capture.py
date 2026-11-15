"""`scripts/serve_capture.py`——起動の段を替えた本体が、DBを読まずに起きて、DBを読まない口を返す。

DBは、本体がセッションの工場を引いたら落ちるようにして、起動の段がDBを読まないことを見る。下地のスタイルは、上流へ出ずに
済むよう前の世代がディスクに残した形（`tile_cache`。置き場は`tests/conftest.py`がテストごとの一時ディレクトリへ向ける）で置く。

ここで見ないもの:
- 下地の取り次ぎの書き換えとキャッシュ → `test_basemap_client.py`
"""

import json

import pytest
from fastapi.testclient import TestClient

import serve_capture
from app import main
from app.config import settings
from app.infrastructure import tile_cache


def reading_the_database():
    raise AssertionError("起動の段がDBを読んだ")


@pytest.fixture
def started_without_db(monkeypatch):
    monkeypatch.setattr(main, "get_session_factory", reading_the_database)
    monkeypatch.setattr(main.app.router, "lifespan_context", serve_capture.without_db)
    with TestClient(main.app) as client:
        yield client


def test_starts_without_reading_the_database_and_serves_the_basemap_style(started_without_db):
    upstream = {"sprite": "https://tiles.openfreemap.org/sprites/ofm_f384/ofm"}
    tile_cache.set("basemap-raw/styles/liberty", json.dumps(upstream).encode(), "application/json")

    response = started_without_db.get("/api/basemap/styles/liberty")

    assert response.status_code == 200
    assert response.json()["sprite"] == f"{settings.basemap_public_base_url}/sprites/ofm_f384/ofm"
