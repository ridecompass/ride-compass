"""ひな形の管理API（`/api/admin/route-profiles`）と、公開したひな形が画面の設定（`GET /api/client-config`）へ届くことと、
費用の軸・道の区分の書き込みが、消えた軸・行の設定をひな形から同じ書き込みで外すこと。

注入から本物を通し、アプリのセッション工場をテストDBへ向ける。

ここで見ないもの:
- 起動時の読み込みが、今に無い名を指すひな形で止まること → `test_definitions_loading.py`
- 認証 → `test_admin_route_authorization.py`
"""

import httpx
import pytest
import pytest_asyncio

from app.domain.cost_axes import EFFORT_AXES
from app.domain.map_display import MAP_LAYER_CATEGORIES
from app.domain.road_classes import EMPTY_ROAD_CLASSES, AvoidanceClassification, AvoidanceOverride
from app.main import app
from tests.admin_auth import AUTH_HEADERS
from tests.road_class_fixture import classification, map_layer, road_classes

pytestmark = pytest.mark.asyncio(loop_scope="module")

PATH = "/api/admin/route-profiles"
ROAD_CLASSES_PATH = "/api/admin/road-classes"
COST_AXES_PATH = "/api/admin/cost-axes"


def _surface(unpaved_selectable: bool) -> dict:
    """道路タブに分け方「surface」の行を出す区分。`unpaved_selectable`が偽なら、行「surface.unpaved」は選べない（行が消える）。"""
    return road_classes(
        {"surface": classification({"paved": [], "unpaved": []})},
        map_layers={"surface": map_layer().model_copy(update={"group_key": MAP_LAYER_CATEGORIES[0].key})},
        avoidance_classifications={"surface": AvoidanceClassification(
            overrides={} if unpaved_selectable else {"unpaved": AvoidanceOverride(default_level=None, selectable=False)})},
    ).model_dump(mode="json")


LENS = {"thresholds": [1.0], "band_labels": ["少ない", "多い"]}
PRESENTATION = {"label": "軸", "description": "", "icon_id": "icon", "lens": LENS}
VIBRATION = {**PRESENTATION, "burden": {"kind": "categorical", "material": "class:surface",
                                        "per_km": {"paved": 0.0, "unpaved": 0.6}}}


def _cost_axes(*, vibration: bool) -> dict:
    """体力の軸と、`vibration`なら道のストレスの軸「vibration」。"""
    return {"effort": {axis_id: PRESENTATION for axis_id in EFFORT_AXES},
            "burden": {"vibration": VIBRATION} if vibration else {}, "total_lens": PRESENTATION}


def _profile(name: str, *, published: bool, multipliers: dict | None = None, road_avoidance: dict | None = None) -> dict:
    return {"name": name, "description": f"{name}の説明", "published": published,
            "cost_preference": {"strength": 1.5, "multipliers": multipliers or {}, "disabled_axes": []},
            "road_avoidance": road_avoidance or {}}


NIGHT = _profile("夜", published=True, multipliers={"vibration": 2.0}, road_avoidance={"surface.unpaved": "avoid"})
DRAFT = _profile("下書き", published=False)


@pytest_asyncio.fixture(loop_scope="module")
async def client(road_graph_session, app_on_test_database, admin_credentials):
    """テストDBへ向けたアプリの口。区分と費用の軸を書いて始め、終わりに区分を空へ戻す（表の行はセッションの後始末が消す）。"""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.put(ROAD_CLASSES_PATH, json=_surface(True), headers=AUTH_HEADERS)).status_code == 200
        assert (await client.put(COST_AXES_PATH, json=_cost_axes(vibration=True), headers=AUTH_HEADERS)).status_code == 200
        yield client
        await client.put(ROAD_CLASSES_PATH, json=EMPTY_ROAD_CLASSES.model_dump(mode="json"), headers=AUTH_HEADERS)


async def _served(client) -> list[dict]:
    return (await client.get("/api/client-config")).json()["route_profiles"]


async def test_written_profiles_are_read_back_and_only_published_ones_are_served(client):
    """まだ無ければ空。書いた全体はそのまま読み戻り、利用者へは公開のものだけが、公開の印を除いて届く。"""
    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == {"profiles": []}

    written = {"profiles": [NIGHT, DRAFT]}
    assert (await client.put(PATH, json=written, headers=AUTH_HEADERS)).status_code == 200

    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == written
    assert await _served(client) == [{key: value for key, value in NIGHT.items() if key != "published"}]


@pytest.mark.parametrize(
    ("profile", "named"),
    [
        (_profile("夜", published=True, multipliers={"lighting": 2.0}), "lighting"),
        (_profile("夜", published=True, road_avoidance={"surface.gravel": "avoid"}), "surface.gravel"),
    ],
    ids=["軸", "道の段の行"],
)
async def test_profiles_naming_what_is_not_there_are_refused_naming_it(client, profile, named):
    """今の費用の軸・道の段の行に無い名を指すひな形は、書かずに名指して断る（効かない設定を運営に見せたまま配らない）。"""
    response = await client.put(PATH, json={"profiles": [profile]}, headers=AUTH_HEADERS)

    assert response.status_code == 409
    assert named in response.json()["detail"]
    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == {"profiles": []}


async def test_removing_an_axis_or_a_row_removes_its_setting_from_the_profiles_in_the_same_write(client):
    """軸を消す・行を選べなくする書き込みは通り、同じ書き込みでひな形からその設定が外れる（外れた設定は書いていないものと
    同じく標準。利用者がひな形を選んでも、今に無い軸を送って生成を断られない）。"""
    assert (await client.put(PATH, json={"profiles": [NIGHT]}, headers=AUTH_HEADERS)).status_code == 200

    assert (await client.put(COST_AXES_PATH, json=_cost_axes(vibration=False), headers=AUTH_HEADERS)).status_code == 200
    assert (await client.put(ROAD_CLASSES_PATH, json=_surface(False), headers=AUTH_HEADERS)).status_code == 200

    pruned = {**NIGHT, "cost_preference": {**NIGHT["cost_preference"], "multipliers": {}}, "road_avoidance": {}}
    assert (await client.get(PATH, headers=AUTH_HEADERS)).json() == {"profiles": [pruned]}
    assert await _served(client) == [{key: value for key, value in pruned.items() if key != "published"}]
