"""`api/admin_db_errors.py`——管理API（`/api/admin/`配下）のDB障害を、どの口でも503で返すこと。

DBに繋がらない状態は、本物のアプリのセッション工場を接続を断るDBへ向けて作る（本番のDB停止と同じく、
最初の問い合わせで`ConnectionRefusedError`が出る）。口ごとの依存・サービスは本物を通す。

ここで見ないもの:
- どの例外をDB障害に数えるか → `test_database.py`
- 認可 → `test_admin_route_authorization.py`
- DBの失敗を空へ倒す口（材料の値の一覧の`available=false`）の倒し方 → `test_material_catalog_routes.py`
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.api import dependencies
from app.api.admin_db_errors import ADMIN_PATH_PREFIX, install_admin_db_unavailable_handler
from app.domain.region import EDGE_UNIT_MIN_ZOOM
from app.domain.tuning import TUNING_PARAMETERS
from app.domain.road_classes import EMPTY_ROAD_CLASSES
from app.main import app
from app.services.axis_preview_service import new_sample_cache
from tests.admin_auth import AUTH_HEADERS, admin_routes
from tests.axis_system_fixture import axis_definition, replaced_axis_definitions
from tests.conftest import UNREACHABLE_DATABASE_URL
from tests.material_fixture import stored_materials

NUMERIC = stored_materials("numeric")[0]
CATEGORICAL = stored_materials("categorical")[0]
AXIS = "/api/admin/axis-definitions"
SHAPE = {"kind": "breakpoint_linear", "terms": [{"material": NUMERIC}], "breakpoints": [[0, 0], [10, 100]]}
AXIS_BODY = {"axis_id": "a", "label": "軸A", "default_weight": 1.0, "shape": SHAPE}
WAY_VALUES_BODY = {
    "axis_id": "a", "shape": SHAPE, "z": EDGE_UNIT_MIN_ZOOM, "x": 7275, "y": 3225,
    "bearing_deg": 0, "at": "2026-10-18T09:00:00+09:00", "speed_kmh": 20,
}

# 口ごとの(パスの引数を埋めたURL, 本文, DBが落ちたときの状態コード)。母集団はアプリのルートから取るので、
# 管理APIの口を足してここへ足し忘れるとKeyErrorで落ちる。DBを読まない口とDBの失敗を自分で空へ倒す口は200。
ROUTE_CASES = {
    ("GET", AXIS): (AXIS, None, 503),
    ("POST", AXIS): (AXIS, AXIS_BODY, 503),
    ("GET", AXIS + "/{axis_id}"): (AXIS + "/a", None, 503),
    ("PUT", AXIS + "/{axis_id}"): (AXIS + "/a", AXIS_BODY, 503),
    ("DELETE", AXIS + "/{axis_id}"): (AXIS + "/a", None, 503),
    ("POST", AXIS + "/{axis_id}/unpublish"): (AXIS + "/a/unpublish", None, 503),
    ("POST", AXIS + "/preview-distribution"): (AXIS + "/preview-distribution", {"shape": SHAPE}, 503),
    ("POST", AXIS + "/preview-scores"): (AXIS + "/preview-scores", {"shape": SHAPE, "xs": [0.5]}, 200),
    ("POST", AXIS + "/preview-calibration"): (AXIS + "/preview-calibration", {"definition": AXIS_BODY}, 200),
    # タイルの材料はDBの失敗を空へ倒し、地図の配信と同じく塗る道の無いタイルとして返す。
    ("POST", AXIS + "/preview-way-values"): (AXIS + "/preview-way-values", WAY_VALUES_BODY, 200),
    ("GET", "/api/admin/tuning"): ("/api/admin/tuning", None, 503),
    ("GET", "/api/admin/road-classes"): ("/api/admin/road-classes", None, 503),
    ("PUT", "/api/admin/road-classes"): ("/api/admin/road-classes", EMPTY_ROAD_CLASSES.model_dump(mode="json"), 503),
    ("PUT", "/api/admin/tuning/{param_id}"): (f"/api/admin/tuning/{TUNING_PARAMETERS[0].id}", {"value": None}, 503),
    ("GET", "/api/admin/material-catalog/{material_id}/value-shares"): (
        f"/api/admin/material-catalog/{CATEGORICAL}/value-shares",
        None,
        503,
    ),
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
def database_down(override_dependency, monkeypatch):
    engine = create_async_engine(UNREACHABLE_DATABASE_URL, poolclass=NullPool)
    for name in ("get_session_factory", "get_route_generation_session_factory"):
        monkeypatch.setattr(dependencies, name, lambda: async_sessionmaker(engine))
    # 分布の標本は一度読むとプロセスに持つため、読んでいない状態から始める。
    override_dependency(dependencies.get_axis_preview_sample_cache, new_sample_cache)
    # 軸の集合は起動時にDBから読んでプロセスに持つので、DBが落ちても軸`a`は引ける。
    with replaced_axis_definitions({"a": axis_definition("a", material=NUMERIC)}):
        yield


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


@pytest.mark.parametrize(
    ("path", "error"),
    [
        # 管理API以外の口は、DB障害を空へ倒すか500で表へ出すかを口ごとに決めている。
        ("/api/probe", DBAPIError("SELECT 1", {}, Exception("接続できない"))),
        # 実装の誤りをDB障害として返すと、直す場所を取り違える。
        (ADMIN_PATH_PREFIX + "probe", TypeError("wrong arguments")),
    ],
    ids=["db-failure-outside-admin", "implementation-error-in-admin"],
)
def test_other_failures_stay_unhandled_errors(path, error):
    probe = FastAPI()
    install_admin_db_unavailable_handler(probe)

    @probe.get(path)
    async def fail() -> None:
        raise error

    with pytest.raises(type(error)):
        TestClient(probe).get(path)
