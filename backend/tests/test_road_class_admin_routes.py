"""道の区分の管理API（`/api/admin/road-classes`）と、書いた区分が軸カタログ（`GET /api/axis-catalog`）へ届くこと。

注入から本物を通し、アプリのセッション工場をテストDBへ向ける。表の制約が守る形はここで見ない（構造仕様15）。

ここで見ないもの:
- 配る形の組み立て（色・注・除外の行） → `test_road_class_catalog.py`
- 認証 → `test_admin_route_authorization.py`、DBに届かないときの503 → `test_admin_db_unavailable.py`
"""

import httpx
import pytest
import pytest_asyncio

from app.config import settings
from app.domain.road_classes import EMPTY_ROAD_CLASSES, AvoidanceClassification, AvoidanceOverride, AvoidanceSection
from app.infrastructure import database
from app.main import app
from tests.admin_auth import AUTH_HEADERS
from tests.conftest import postgis_database_url
from tests.road_class_fixture import classification, fact_is, map_layer, road_classes

pytestmark = pytest.mark.asyncio(loop_scope="module")

PATH = "/api/admin/road-classes"

#: 子の行（区分・条件・項・除外の上書き）を持つ表にも行がある全体。
DEFINITIONS = road_classes(
    {"surface": classification({"paved": [fact_is("cat_a", "asphalt"), fact_is("cat_b", "x")], "unpaved": []})},
    map_layers={"surface": map_layer()},
    rolling_resistance_classification="surface",
    rolling_resistance_classes={"surface": {"paved": "crr_paved"}},
    avoidance_sections={"main": AvoidanceSection(label="主", description="", sort_order=0)},
    avoidance_classifications={
        "surface": AvoidanceClassification(
            section_key="main",
            sort_order=0,
            overrides={"unpaved": AvoidanceOverride(section_key=None, default_level="avoid", selectable=True)},
        ),
    },
).model_dump(mode="json")


@pytest_asyncio.fixture(loop_scope="module")
async def client(road_graph_session, admin_credentials, monkeypatch):
    """アプリのセッション工場をテストDBへ向けた口。終わりに空の全体を書き、表とプロセス内の全体を空へ戻す。"""
    monkeypatch.setattr(settings, "database_url", postgis_database_url())
    await database.dispose_engines()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client
        await client.put(PATH, json=EMPTY_ROAD_CLASSES.model_dump(mode="json"), headers=AUTH_HEADERS)
    await database.dispose_engines()


async def test_written_definitions_are_read_back_and_served(client):
    """書いた全体がそのまま読み戻り、公開した分け方が軸カタログに出る。"""
    assert (await client.put(PATH, json=DEFINITIONS, headers=AUTH_HEADERS)).status_code == 200
    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == DEFINITIONS
    served = (await client.get("/api/axis-catalog")).json()["road_classes"]
    assert [(layer["id"], [c["key"] for c in layer["classes"]]) for layer in served["map_layers"]] == [("surface", ["paved", "unpaved"])]
