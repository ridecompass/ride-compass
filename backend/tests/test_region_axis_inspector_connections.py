"""区間インスペクタ（`POST /api/region/axis-inspector`）の1要求が、DBの接続を同時に何本持つか。

接続のプールはタイル配信と分け合っており（`config.py`の上限）、1回の内訳で2本持つと、地図を動かしている間の
タイルが接続の空きを待つ。注入（`api/dependencies.py: get_axis_inspector_service`）から本物を通し、アプリの
セッション工場をテストDBへ向けて、プールから貸し出された接続の数を数える。押す道は取込と道路網の導出を通して置き、
内訳が道・区間とタイルの材料・配信の値（DBを読む勾配と、気象も読む風）を読むところまで進ませる。

ここで見ないもの:
- 内訳の中身と、要求のどの値がどこへ渡るか → `test_region_routes.py`
- 材料の値そのもの → 材料ごとの配信サービスのテスト（例: `test_gradient_way_service.py`）
"""

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import event

from app.batch import derive_topology
from app.config import settings
from app.domain.axis_definitions import AxisDefinition, BreakpointLinearShape, MaterialTerm
from app.domain.region import EDGE_UNIT_MIN_ZOOM, tile_bounds_lonlat
from app.infrastructure import database
from app.main import app
from tests.axis_system_fixture import replaced_axis_definitions
from tests.conftest import postgis_database_url, raw_connection
from tests.source_ingest import ingest_records, way_record

pytestmark = pytest.mark.asyncio(loop_scope="module")

#: DBを読んで値を出す配信の軸（勾配）。方位だけで引けるので、要求の欄だけで材料の取得まで進む。
GRADIENT_AXIS = AxisDefinition(
    axis_id="axis_gradient",
    shape=BreakpointLinearShape(
        terms=[MaterialTerm(material="gradient_percent")],
        preprocess="abs",
        breakpoints=[(0.0, 0.0), (10.0, 100.0)],
    ),
    default_weight=0.2,
    label="勾配",
    is_published=True,
)

#: 気象を読む配信の軸（風）。注入が気象のサービスを渡さないと、内訳が開かない。
WIND_AXIS = AxisDefinition(
    axis_id="axis_wind",
    shape=BreakpointLinearShape(terms=[MaterialTerm(material="wind_drag_ratio")], breakpoints=[(0.0, 0.0), (2.0, 100.0)]),
    default_weight=0.2,
    label="風",
    is_published=True,
)

#: 押すタイル。押す道はこのタイルの中に置く。
TILE = (EDGE_UNIT_MIN_ZOOM, 14551, 6447)


@pytest_asyncio.fixture(loop_scope="module")
async def app_on_test_database(road_graph_engine, monkeypatch):
    """アプリのセッション工場を、表を作ったテストDBへ向ける。工場はプロセスに1つなので、作り直してから始め、閉じて終える。"""
    monkeypatch.setattr(settings, "database_url", postgis_database_url())
    await database.dispose_engines()
    yield
    await database.dispose_engines()


@pytest.mark.usefixtures("app_on_test_database")
async def test_one_inspection_holds_one_connection_at_a_time():
    bounds = tile_bounds_lonlat(*TILE)
    south, west = bounds.min_latitude, bounds.min_longitude
    north, east = bounds.max_latitude, bounds.max_longitude
    middle = (south + north) / 2
    await ingest_records("osm_way", [way_record(1, [(west + (east - west) * t, middle) for t in (0.2, 0.5, 0.8)],
                                                [1, 2, 3])], bbox=(south, west, north, east))
    async with raw_connection() as conn:
        await derive_topology.derive(conn)
    pool = database.get_session_factory().kw["bind"].sync_engine.pool
    held = {"now": 0, "most": 0}

    def checked_out(*_):
        held["now"] += 1
        held["most"] = max(held["most"], held["now"])

    def checked_in(*_):
        held["now"] -= 1

    event.listen(pool, "checkout", checked_out)
    event.listen(pool, "checkin", checked_in)
    transport = httpx.ASGITransport(app=app)
    with replaced_axis_definitions({axis.axis_id: axis for axis in (GRADIENT_AXIS, WIND_AXIS)}):
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/api/region/axis-inspector",
                json={"osm_way_id": 1, "feature_key": "1-0", "point": {"latitude": middle, "longitude": west},
                      "z": TILE[0], "x": TILE[1], "y": TILE[2], "bearing_deg": 90.0, "speed_kmh": 20.0},
            )

    assert response.status_code == 200
    assert response.json()["way"]["axes"]
    assert held["most"] == 1
