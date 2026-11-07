"""`api/failure_replies.py`——DB障害を、どの口でも503で返すこと（管理APIの口は全部を本物で叩く）。

DBに繋がらない状態は、アプリのセッション工場の依存を、接続を断るDBへ向けた工場で上書きして作る（本番のDB停止と同じく、
最初の問い合わせで`ConnectionRefusedError`が出る）。口ごとの依存・サービスは本物を通す。

ここで見ないもの:
- どの例外をDB障害に数えるか → `test_database.py`
- 認可 → `test_admin_route_authorization.py`
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.api.admin_paths import ADMIN_PATH_PREFIX
from app.api.failure_replies import install_failure_replies
from app.domain.cost_axes import EFFORT_AXES
from app.domain.tuning import TUNING_PARAMETERS
from app.domain.road_classes import EMPTY_ROAD_CLASSES
from app.infrastructure import database
from app.main import app
from tests.admin_auth import AUTH_HEADERS, admin_routes
from tests.conftest import UNREACHABLE_DATABASE_URL
from tests.tuning_fixture import TUNING

COST_AXES_BODY = {
    "effort": {axis_id: {"label": axis_id, "description": "", "icon_id": "i",
                         "lens": {"thresholds": [1.0], "band_labels": ["a", "b"]}} for axis_id in EFFORT_AXES},
    "burden": {},
    "total_lens": {"label": "総合", "description": "", "icon_id": "i",
                   "lens": {"thresholds": [1.0], "band_labels": ["a", "b"]}},
}

# 口ごとの(パスの引数を埋めたURL, 本文, DBが落ちたときの状態コード)。母集団はアプリのルートから取るので、
# 管理APIの口を足してここへ足し忘れるとKeyErrorで落ちる。DBを読まない口とDBの失敗を自分で空へ倒す口は200。
ROUTE_CASES = {
    ("GET", "/api/admin/tuning"): ("/api/admin/tuning", None, 200),
    ("GET", "/api/admin/road-classes"): ("/api/admin/road-classes", None, 503),
    ("PUT", "/api/admin/road-classes"): ("/api/admin/road-classes", EMPTY_ROAD_CLASSES.model_dump(mode="json"), 503),
    ("GET", "/api/admin/cost-axes"): ("/api/admin/cost-axes", None, 503),
    ("PUT", "/api/admin/cost-axes"): ("/api/admin/cost-axes", COST_AXES_BODY, 503),
    ("PUT", "/api/admin/tuning/{param_id}"): (f"/api/admin/tuning/{TUNING_PARAMETERS[0].id}", {"value": TUNING[TUNING_PARAMETERS[0].id]}, 503),
    ("GET", "/api/admin/material-catalog/coverage"): ("/api/admin/material-catalog/coverage", None, 503),
    ("GET", "/api/admin/derived-data/freshness"): ("/api/admin/derived-data/freshness", None, 503),
    ("GET", "/api/admin/db-status"): ("/api/admin/db-status", None, 503),
    ("POST", "/api/admin/basemap/refresh"): ("/api/admin/basemap/refresh", None, 200),
    ("GET", "/api/admin/debug/mode"): ("/api/admin/debug/mode", None, 200),
    ("POST", "/api/admin/debug/mode"): ("/api/admin/debug/mode", {"enabled": False}, 200),
    ("GET", "/api/admin/debug/logs"): ("/api/admin/debug/logs", None, 200),
}
ROUTES = [(method, route.path) for route in admin_routes(app) for method in sorted(route.methods)]


@pytest.fixture
def database_down(monkeypatch):
    engine = create_async_engine(UNREACHABLE_DATABASE_URL, poolclass=NullPool)
    for factory in (database.get_session_factory, database.get_route_generation_session_factory):
        monkeypatch.setitem(app.dependency_overrides, factory, lambda: async_sessionmaker(engine))


# debug_modeの切替の口も本物で叩くため、切り替えた状態を後のテストへ残さない。
@pytest.mark.usefixtures("restore_debug_mode")
@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_a_database_failure_becomes_a_503_on_every_admin_route_that_reads_it(
    database_down, admin_credentials, method, path
):
    url, body, expected = ROUTE_CASES[(method, path)]

    response = TestClient(app).request(method, url, json=body, headers=AUTH_HEADERS)

    assert response.status_code == expected
    if expected == 503:
        assert "DBへのアクセスに失敗しました" in response.json()["detail"]


def test_an_implementation_error_stays_an_unhandled_error():
    """実装の誤りをDB障害として返すと、直す場所を取り違える。"""
    probe = FastAPI()
    install_failure_replies(probe)

    @probe.get(ADMIN_PATH_PREFIX + "probe")
    async def fail() -> None:
        raise TypeError("wrong arguments")

    with pytest.raises(TypeError):
        TestClient(probe).get(ADMIN_PATH_PREFIX + "probe")
