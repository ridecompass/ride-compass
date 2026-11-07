"""道の区分の管理API（`/api/admin/road-classes`）と、書いた区分が画面の設定（`GET /api/client-config`）へ届くこと。

注入から本物を通し、アプリのセッション工場をテストDBへ向ける。表の制約が守る形はここで見ない（構造仕様15）。コードの宣言を
名指す欄は宣言にある名で書く（宣言の実在を書く側が確かめる）。

ここで見ないもの:
- 配る形の組み立て（色・注・除外の行） → `test_road_class_catalog.py`
- 宣言に無い名指しの欄ごとの判定 → `test_road_classes.py`
- 認証 → `test_admin_route_authorization.py`
- 費用の軸の定義に照らして断ること → `test_cost_axis_admin_routes.py`
"""

import httpx
import pytest
import pytest_asyncio

from app.domain.cycling_speed import BASE_CRR_ID
from app.domain.map_display import MAP_LAYER_CATEGORIES
from app.domain.material_catalog import MATERIAL_CATALOG
from app.domain.road_classes import (
    EMPTY_ROAD_CLASSES,
    AvoidanceClassification,
    AvoidanceOverride,
)
from app.main import app
from tests.admin_auth import AUTH_HEADERS
from tests.road_class_fixture import classification, fact_is, map_layer, road_classes

pytestmark = pytest.mark.asyncio(loop_scope="module")

PATH = "/api/admin/road-classes"
FACT_A, FACT_B = list(MATERIAL_CATALOG)[:2]

#: 子の行（区分・条件・項・除外の上書き）を持つ表にも行がある全体。
DEFINITIONS = road_classes(
    {"surface": classification({"paved": [fact_is(FACT_A, "asphalt"), fact_is(FACT_B, "x")], "unpaved": []})},
    map_layers={"surface": map_layer().model_copy(update={"group_key": MAP_LAYER_CATEGORIES[0].key})},
    rolling_resistance_classification="surface",
    rolling_resistance_classes={"surface": {"paved": BASE_CRR_ID}},
    avoidance_classifications={
        "surface": AvoidanceClassification(
            overrides={"unpaved": AvoidanceOverride(default_level="avoid", selectable=True)},
        ),
    },
).model_dump(mode="json")


@pytest_asyncio.fixture(loop_scope="module")
async def client(road_graph_session, app_on_test_database, admin_credentials):
    """テストDBへ向けたアプリの口。終わりに空の全体を書き、表とプロセス内の全体を空へ戻す。"""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client
        await client.put(PATH, json=EMPTY_ROAD_CLASSES.model_dump(mode="json"), headers=AUTH_HEADERS)


async def test_written_definitions_are_read_back_and_served(client):
    """書いた全体がそのまま読み戻り、公開した分け方が画面の設定に出る。"""
    assert (await client.put(PATH, json=DEFINITIONS, headers=AUTH_HEADERS)).status_code == 200
    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == DEFINITIONS
    served = (await client.get("/api/client-config")).json()["road_classes"]
    assert [(layer["id"], [c["key"] for c in layer["classes"]]) for layer in served["map_layers"]] == [("surface", ["paved", "unpaved"])]


def _two_avoidance_layers(labels: tuple[str, str], sort_orders: tuple[int, int]) -> dict:
    """道路タブに出す分け方を2つ持つ全体。分け方の名前と層の並びは引数で決める。"""
    group = MAP_LAYER_CATEGORIES[0].key
    return road_classes(
        {key: classification({"c": []}).model_copy(update={"label": label}) for key, label in zip(("a", "b"), labels, strict=True)},
        map_layers={
            key: map_layer(order).model_copy(update={"group_key": group})
            for key, order in zip(("a", "b"), sort_orders, strict=True)
        },
        avoidance_classifications={key: AvoidanceClassification(overrides={}) for key in ("a", "b")},
    ).model_dump(mode="json")


async def test_avoidance_sections_follow_classification_labels_and_layer_order(client):
    """道路タブの見出しは、管理APIで直した分け方の名前と層の並びに、次の読み込みから従う（凡例と食い違わない）。"""
    async def served_sections() -> list[tuple[str, str]]:
        avoidance = (await client.get("/api/client-config")).json()["road_classes"]["avoidance"]
        return [(section["key"], section["label"]) for section in avoidance["sections"]]

    assert (await client.put(PATH, json=_two_avoidance_layers(("A", "B"), (0, 1)), headers=AUTH_HEADERS)).status_code == 200
    assert await served_sections() == [("a", "A"), ("b", "B")]
    assert (await client.put(PATH, json=_two_avoidance_layers(("A2", "B"), (1, 0)), headers=AUTH_HEADERS)).status_code == 200
    assert await served_sections() == [("b", "B"), ("a", "A2")]


async def test_replacement_naming_an_undeclared_tuning_value_is_refused(client):
    """転がり抵抗の較正値のidが宣言に無い入れ替えは、その名を挙げて断り、何も変えない。"""
    misspelled = {**DEFINITIONS, "rolling_resistance_classes": {"surface": {"paved": "speed.crr_pavd"}}}
    response = await client.put(PATH, json=misspelled, headers=AUTH_HEADERS)
    assert response.status_code == 409
    assert "speed.crr_pavd" in response.json()["detail"]
    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == EMPTY_ROAD_CLASSES.model_dump(mode="json")
