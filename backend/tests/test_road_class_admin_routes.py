"""道の区分の管理API（`/api/admin/road-classes`）と、書いた区分が軸カタログ（`GET /api/axis-catalog`）へ届くこと。

注入から本物を通し、アプリのセッション工場をテストDBへ向ける。表の制約が断る形の1つずつはここで見ない——制約はDBが守り、
ここは断られたときの返し方を1つの形で見る（構造仕様15）。

ここで見ないもの:
- 配る形の組み立て（色・注・除外の行） → `test_road_class_catalog.py`
- 認証 → `test_admin_route_authorization.py`、DBに届かないときの503 → `test_admin_db_unavailable.py`
"""

import httpx
import pytest
import pytest_asyncio

from app.config import settings
from app.domain.road_classes import EMPTY_ROAD_CLASSES
from app.infrastructure import database
from app.main import app
from tests.admin_auth import AUTH_HEADERS
from tests.conftest import postgis_database_url

pytestmark = pytest.mark.asyncio(loop_scope="module")

PATH = "/api/admin/road-classes"


def _term(values: list[str], negated: bool = False, matches_absent: bool = False) -> dict:
    return {"fact_values": values, "negated": negated, "matches_absent": matches_absent}


def _class(label: str, sort_order: int, conditions: list[dict]) -> dict:
    return {"label": label, "description": f"{label}の道", "sort_order": sort_order, "former_keys": [], "conditions": conditions}


#: 全部の表に行を持つ全体。辞書は鍵の順に置く（読みは鍵の順に返す）。
DEFINITIONS = {
    "classifications": {
        "surface": {
            "label": "路面",
            "description": "",
            "is_published": True,
            "classes": {
                "paved": _class("舗装", 0, [{"cat_a": _term(["asphalt"]), "bool_a": _term(["true"], negated=True, matches_absent=True)}]),
                "unpaved": _class("未舗装", 1, [{"cat_a": _term(["gravel"])}, {"cat_a": _term([], matches_absent=True)}]),
            },
        },
    },
    "map_layers": {
        "surface": {
            "group_key": "road",
            "sort_order": 0,
            "icon_key": "surface",
            "summary": "路面の種類",
            "panel_hint": "ヒント",
            "palette": "nominal",
            "hue_slot": 3,
            "tone": None,
            "no_data_fact_key": None,
            "hides_unclassified": False,
        },
    },
    "rolling_resistance_classification": "surface",
    "rolling_resistance_classes": {"surface": {"paved": "crr_paved", "unpaved": "crr_unpaved"}},
    "avoidance_sections": {"main": {"label": "主", "description": "", "sort_order": 0}},
    "avoidance_classifications": {
        "surface": {
            "section_key": "main",
            "sort_order": 0,
            "overrides": {"unpaved": {"section_key": None, "default_level": "avoid", "selectable": True}},
        },
    },
}


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
    written = await client.put(PATH, json=DEFINITIONS, headers=AUTH_HEADERS)
    assert written.status_code == 200
    assert written.json() == DEFINITIONS
    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == DEFINITIONS
    served = (await client.get("/api/axis-catalog")).json()["road_classes"]
    assert [(layer["id"], [c["key"] for c in layer["classes"]]) for layer in served["map_layers"]] == [("surface", ["paved", "unpaved"])]
    assert [(row["key"], row["default"]) for row in served["avoidance"]["rows"]] == [("surface.paved", "pass"), ("surface.unpaved", "avoid")]


async def test_definitions_the_tables_reject_leave_the_previous_ones(client):
    """表の制約が断った全体は409で断りの文を返し、前の全体を表にもカタログにも残す。"""
    await client.put(PATH, json=DEFINITIONS, headers=AUTH_HEADERS)
    rejected = await client.put(PATH, json={**DEFINITIONS, "rolling_resistance_classification": "missing"}, headers=AUTH_HEADERS)
    assert rejected.status_code == 409
    assert "road_rolling_resistance" in rejected.json()["detail"]
    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == DEFINITIONS
    served = (await client.get("/api/axis-catalog")).json()["road_classes"]
    assert [layer["id"] for layer in served["map_layers"]] == ["surface"]
