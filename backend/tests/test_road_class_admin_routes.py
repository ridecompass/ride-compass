"""道の区分の管理API（`/api/admin/road-classes`）と、書いた区分が軸カタログ（`GET /api/axis-catalog`）へ届くこと。

注入から本物を通し、アプリのセッション工場をテストDBへ向ける。表の制約が守る形はここで見ない（構造仕様15）。コードの宣言を
名指す欄は宣言にある名で書く（宣言の実在を書く側が確かめる）。

ここで見ないもの:
- 配る形の組み立て（色・注・除外の行） → `test_road_class_catalog.py`
- 宣言に無い名指しの欄ごとの判定 → `test_road_classes.py`
- 認証 → `test_admin_route_authorization.py`、DBに届かないときの503 → `test_admin_db_unavailable.py`
"""

import httpx
import pytest
import pytest_asyncio

from app.domain.axis_definitions import CategoricalShape
from app.domain.cycling_speed import BASE_CRR_ID
from app.domain.map_display import MAP_LAYER_CATEGORIES
from app.domain.material_catalog import MATERIAL_CATALOG
from app.domain.road_classes import (
    EMPTY_ROAD_CLASSES,
    AvoidanceClassification,
    AvoidanceOverride,
    class_material_id,
)
from app.infrastructure.axis_definition_repository import AxisDefinitionRepository
from app.main import app
from tests.admin_auth import AUTH_HEADERS
from tests.axis_system_fixture import shaped_axis
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
    """書いた全体がそのまま読み戻り、公開した分け方が軸カタログに出る。"""
    assert (await client.put(PATH, json=DEFINITIONS, headers=AUTH_HEADERS)).status_code == 200
    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == DEFINITIONS
    served = (await client.get("/api/axis-catalog")).json()["road_classes"]
    assert [(layer["id"], [c["key"] for c in layer["classes"]]) for layer in served["map_layers"]] == [("surface", ["paved", "unpaved"])]


def _two_avoidance_layers(labels: tuple[str, str], sort_orders: tuple[int, int]) -> dict:
    """除外タブに出す分け方を2つ持つ全体。分け方の名前と層の並びは引数で決める。"""
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
    """除外タブの見出しは、管理APIで直した分け方の名前と層の並びに、次の読み込みから従う（凡例と食い違わない）。"""
    async def served_sections() -> list[tuple[str, str]]:
        avoidance = (await client.get("/api/axis-catalog")).json()["road_classes"]["avoidance"]
        return [(section["key"], section["label"]) for section in avoidance["sections"]]

    assert (await client.put(PATH, json=_two_avoidance_layers(("A", "B"), (0, 1)), headers=AUTH_HEADERS)).status_code == 200
    assert await served_sections() == [("a", "A"), ("b", "B")]
    assert (await client.put(PATH, json=_two_avoidance_layers(("A2", "B"), (1, 0)), headers=AUTH_HEADERS)).status_code == 200
    assert await served_sections() == [("b", "B"), ("a", "A2")]


@pytest_asyncio.fixture(loop_scope="module")
async def axis_reading_surface(client, road_graph_session):
    """分け方`surface`の区分を材料に読む下書きの軸が、DBにある。終わりに消す（区分を空へ戻す`client`の片付けより先）。"""
    repository = AxisDefinitionRepository(road_graph_session)
    axis = shaped_axis(CategoricalShape(material=class_material_id("surface"), mapping={"paved": 100.0}))
    await repository.upsert(axis, 0)
    await repository.commit()
    yield axis
    await repository.delete(axis.axis_id)
    await repository.commit()


async def test_replacement_dropping_a_classification_an_axis_reads_is_refused(client, axis_reading_surface):
    """軸が材料に読む分け方を消す入れ替えは、確定すると次の起動で軸を読み込めないので、その軸を名指して断り、何も変えない。"""
    assert (await client.put(PATH, json=DEFINITIONS, headers=AUTH_HEADERS)).status_code == 200
    response = await client.put(PATH, json=EMPTY_ROAD_CLASSES.model_dump(mode="json"), headers=AUTH_HEADERS)
    assert response.status_code == 409
    assert axis_reading_surface.label in response.json()["detail"]
    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == DEFINITIONS


async def test_replacement_naming_an_undeclared_tuning_value_is_refused(client):
    """転がり抵抗の較正値のidが宣言に無い入れ替えは、その名を挙げて断り、何も変えない。"""
    misspelled = {**DEFINITIONS, "rolling_resistance_classes": {"surface": {"paved": "speed.crr_pavd"}}}
    response = await client.put(PATH, json=misspelled, headers=AUTH_HEADERS)
    assert response.status_code == 409
    assert "speed.crr_pavd" in response.json()["detail"]
    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == EMPTY_ROAD_CLASSES.model_dump(mode="json")


def _renamed_paved(former_keys: list[str]) -> dict:
    """`DEFINITIONS`の区分`paved`を`sealed`へ改名した全体（前の鍵は`former_keys`）。区分を指す欄も新しい鍵へ移す。"""
    renamed = {**DEFINITIONS, "rolling_resistance_classes": {"surface": {"sealed": BASE_CRR_ID}}}
    classes = renamed["classifications"]["surface"]["classes"]
    sealed = {**classes["paved"], "former_keys": former_keys}
    renamed["classifications"] = {"surface": {**renamed["classifications"]["surface"], "classes": {"sealed": sealed, "unpaved": classes["unpaved"]}}}
    return renamed


async def test_renaming_a_class_an_axis_scores_needs_its_former_key(client, axis_reading_surface):
    """軸が点数を付ける区分の改名は、前の鍵を残せば確定し（軸は前の名で引き続ける）、前の鍵が無ければ、どの道にも当たらない
    値を軸が名指すことになるので、軸と値を名指して断り、何も変えない。"""
    assert (await client.put(PATH, json=DEFINITIONS, headers=AUTH_HEADERS)).status_code == 200
    refused = await client.put(PATH, json=_renamed_paved([]), headers=AUTH_HEADERS)
    assert refused.status_code == 409
    assert axis_reading_surface.label in refused.json()["detail"] and "「paved」" in refused.json()["detail"]
    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == DEFINITIONS

    renamed = _renamed_paved(["surface.paved"])
    assert (await client.put(PATH, json=renamed, headers=AUTH_HEADERS)).status_code == 200
    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == renamed
