"""費用の軸の定義の管理API（`/api/admin/cost-axes`）と、道の区分の入れ替えが費用の軸の定義を通し直すこと。

注入から本物を通し、アプリのセッション工場をテストDBへ向ける。

ここで見ないもの:
- 定義の形と、材料・区分に照らす検証の判定ごと → `test_cost_axes.py`
- 認証 → `test_admin_route_authorization.py`
"""

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import delete

from app.domain.cost_axes import EFFORT_AXES, current_cost_axes
from app.domain.road_classes import EMPTY_ROAD_CLASSES
from app.infrastructure.cost_axis_models import CostAxisDefinitionsRow
from app.main import app
from tests.admin_auth import AUTH_HEADERS
from tests.road_class_fixture import classification, road_classes

pytestmark = pytest.mark.asyncio(loop_scope="module")

PATH = "/api/admin/cost-axes"
ROAD_CLASSES_PATH = "/api/admin/road-classes"
SURFACE = road_classes({"surface_estimate": classification({"paved": [], "gravel": []})}).model_dump(mode="json")
LENS = {"thresholds": [1.0], "band_labels": ["少ない", "多い"]}
DEFINITIONS = {
    "effort": {axis_id: {"label": axis_id, "description": "", "icon_id": "icon", "lens": LENS} for axis_id in EFFORT_AXES},
    "burden": {"vibration": {"label": "振動", "description": "", "icon_id": "icon", "lens": LENS,
                             "burden": {"kind": "categorical", "material": "class:surface_estimate",
                                        "per_km": {"paved": 0.0, "gravel": 0.6}}}},
    "total_lens": {"label": "総合", "description": "", "icon_id": "icon", "lens": LENS},
}


@pytest_asyncio.fixture(loop_scope="module")
async def client(road_graph_session, app_on_test_database, admin_credentials):
    """テストDBへ向けたアプリの口。区分を書いて始め、終わりに費用の軸の定義の行を消し、区分を空へ戻す。"""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.put(ROAD_CLASSES_PATH, json=SURFACE, headers=AUTH_HEADERS)).status_code == 200
        yield client
        await road_graph_session.execute(delete(CostAxisDefinitionsRow))
        await road_graph_session.commit()
        await client.put(ROAD_CLASSES_PATH, json=EMPTY_ROAD_CLASSES.model_dump(mode="json"), headers=AUTH_HEADERS)


async def test_written_definitions_are_read_back_and_take_effect(client):
    """まだ全体が無ければ読むと404。書いた全体はそのまま読み戻り、このプロセスの定義になる。"""
    assert (await client.get(PATH, headers=AUTH_HEADERS)).status_code == 404

    assert (await client.put(PATH, json=DEFINITIONS, headers=AUTH_HEADERS)).status_code == 200

    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == DEFINITIONS
    assert current_cost_axes().model_dump(mode="json") == DEFINITIONS


async def test_definitions_that_do_not_fit_the_road_classes_are_refused_with_the_reason(client):
    """区分に重さの無い道のストレスの軸は、書く前に断る（書いていない区分を0とみなすと、その道のストレスが黙って消える）。"""
    missing_class = {**DEFINITIONS, "burden": {"vibration": {
        **DEFINITIONS["burden"]["vibration"],
        "burden": {"kind": "categorical", "material": "class:surface_estimate", "per_km": {"paved": 0.0}}}}}

    response = await client.put(PATH, json=missing_class, headers=AUTH_HEADERS)

    assert response.status_code == 409
    assert "重さの無い区分 ['gravel']" in response.json()["detail"]


async def test_replacing_the_road_classes_rechecks_the_cost_axes(client):
    """道の区分を入れ替えて区分を足すと、費用の軸の重さが漏れる。区分の入れ替えのほうを断る。"""
    assert (await client.put(PATH, json=DEFINITIONS, headers=AUTH_HEADERS)).status_code == 200
    wider = road_classes({"surface_estimate": classification({"paved": [], "gravel": [], "soil": []})}).model_dump(mode="json")

    response = await client.put(ROAD_CLASSES_PATH, json=wider, headers=AUTH_HEADERS)

    assert response.status_code == 409
    assert "重さの無い区分 ['soil']" in response.json()["detail"]


def _vibration(per_km: dict[str, float]) -> dict:
    return {**DEFINITIONS, "burden": {"vibration": {
        **DEFINITIONS["burden"]["vibration"],
        "burden": {"kind": "categorical", "material": "class:surface_estimate", "per_km": per_km}}}}


def _surface(*classes: str) -> dict:
    return road_classes({"surface_estimate": classification({name: [] for name in classes})}).model_dump(mode="json")


def _surplus_warnings(caplog) -> list[str]:
    return [record.getMessage() for record in caplog.records if "分け方に無い区分の重さ" in record.getMessage()]


async def test_a_class_is_added_after_its_weight_without_taking_the_axis_off(client, caplog):
    """区分を足すときは、費用の軸へ重さを先に書ける。区分を足すまでは余りの重さとして警告する（区分名の打ち間違いを知らせる）。"""
    with caplog.at_level("WARNING", logger="ridecompass.cost_axes"):
        response = await client.put(PATH, json=_vibration({"paved": 0.0, "gravel": 0.6, "soil": 0.8}), headers=AUTH_HEADERS)
    assert response.status_code == 200
    assert _surplus_warnings(caplog) == ["費用の軸に分け方に無い区分の重さが残っています（vibration: 分け方に無い区分の重さ ['soil']）"]
    caplog.clear()

    with caplog.at_level("WARNING", logger="ridecompass.cost_axes"):
        response = await client.put(ROAD_CLASSES_PATH, json=_surface("paved", "gravel", "soil"), headers=AUTH_HEADERS)
    assert response.status_code == 200
    assert _surplus_warnings(caplog) == []


async def test_a_class_is_removed_before_its_weight_without_taking_the_axis_off(client, caplog):
    """区分を消すときは、区分を先に消せる。残った重さは余りとして警告し、あとで軸から消せる。"""
    assert (await client.put(PATH, json=DEFINITIONS, headers=AUTH_HEADERS)).status_code == 200

    with caplog.at_level("WARNING", logger="ridecompass.cost_axes"):
        response = await client.put(ROAD_CLASSES_PATH, json=_surface("paved"), headers=AUTH_HEADERS)
    assert response.status_code == 200
    assert _surplus_warnings(caplog) == ["費用の軸に分け方に無い区分の重さが残っています（vibration: 分け方に無い区分の重さ ['gravel']）"]

    assert (await client.put(PATH, json=_vibration({"paved": 0.0}), headers=AUTH_HEADERS)).status_code == 200
