"""composeのpostgresとbackendが、手元のPostgreSQLの接続先（`app/config.py: LOCAL_DATABASE_SERVER`）と
同じ利用者・パスワード・番号・DB名で動くことの検査。

composeのファイルはその値をPythonから読めないので、ここで照らす。崩れると、クラウドの開発環境で
PostGIS統合テスト（`tests/conftest.py`）とcomposeのbackendがDBへつなげない。

ここで見ないもの:
- テストのDBの選び方 → `tests/test_postgis_database_url.py`
"""

from __future__ import annotations

from pathlib import Path

import yaml
from sqlalchemy.engine import make_url

from app.config import Settings

COMPOSE = Path(__file__).resolve().parents[3] / "docker-compose.yml"


def test_compose_runs_the_local_database_server():
    services = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]
    local = make_url(Settings.model_fields["database_url"].default)

    assert services["postgres"]["environment"] == {
        "POSTGRES_USER": local.username,
        "POSTGRES_PASSWORD": local.password,
        "POSTGRES_DB": local.database,
    }
    assert f"{local.port}:5432" in services["postgres"]["ports"]
    # backendはcomposeの中からサービス名でつなぐ。ほかは手元の接続先と同じ。
    assert make_url(services["backend"]["environment"]["DATABASE_URL"]).set(host=local.host) == local
