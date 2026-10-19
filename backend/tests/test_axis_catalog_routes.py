"""`api/routers/axis_catalog.py`——公開軸の一覧（`GET /api/axis-catalog`、認可不要）。

ここで見るもの: 公開軸だけを配ること、軸ごとの欄へ domain の導出を受け渡すこと、domain に低い層の
テストが無い導出（気象のチップ・生値の単位・材料の内訳・専用配信の条件・画面へ配る較正値）の結果。

ここで見ないもの:
- 地図の塗り（値の種類・単位・段・凡例・ラベル） → `test_map_paint.py`、一次属性 → `test_axis_hierarchy.py`
- タイルの世代 → `test_derived_data_revision_service.py`・`test_derived_data_meta.py`
- 軸の項目を応答へそのまま写すこと（表示名・重み・チップの欄等）——書き写しで、判断が無い
- 画面へ配る較正値の顔ぶれ（`tuning.py: client_tuning_values`）——同じ関数がビルド時生成物の`client_tuning`も書き、
  CI がその差分を落とす。画面が読む id は`frontend/src/lib/axisCatalog.ts: CLIENT_TUNING_IDS`が生成物の id に型で縛るので、
  配る集合から抜けると型検査で落ちる（余分に配っても画面は壊れない）
"""

import pytest
from fastapi.testclient import TestClient

from app.api.dependencies import get_region_service
from app.domain import tuning
from app.domain.axis_definitions import (
    AxisDefinition,
    BreakpointLinearShape,
    CategoricalShape,
    MaterialTerm,
)
from app.domain.axis_raw_value import RawValueUnits
from app.domain.material_catalog import MATERIAL_CATALOG, SURFACE_ESTIMATE
from app.domain.way_value_formula import WayValueFormula, condition_names
from app.infrastructure.derived_data_meta import DataRevisions
from app.main import app
from app.services.region_service import RegionService
from tests.axis_system_fixture import axis_definition, replaced_axis_definitions

#: カタログが配る軸。1本ごとに、カタログの別の出し分けを通す性質を持たせる。
CATALOG_AXES: dict[str, AxisDefinition] = {
    # 単一材料の絶対値を評価する軸（地図は符号付きの生値を塗り、生値の単位が定まる）。
    "axis_way_value_signed": AxisDefinition(
        axis_id="axis_way_value_signed",
        shape=BreakpointLinearShape(
            terms=[MaterialTerm(material="gradient_percent")],
            preprocess="abs",
            breakpoints=[(0.0, 0.0), (5.0, 50.0), (10.0, 100.0)],
        ),
        default_weight=0.2,
        label="軸グ",
        is_published=True,
    ),
    # 得点を塗る軸。
    "axis_way_value_scored": AxisDefinition(
        axis_id="axis_way_value_scored",
        shape=BreakpointLinearShape(
            terms=[MaterialTerm(material="wind_drag_ratio")],
            breakpoints=[(-1.0, 0.0), (0.0, 20.0), (4.0, 100.0)],
        ),
        default_weight=0.2,
        label="軸ウ",
        is_published=True,
    ),
    # 分類のshape。地図表示を導出できる。
    "axis_categorical": AxisDefinition(
        axis_id="axis_categorical",
        shape=CategoricalShape(material=SURFACE_ESTIMATE, mapping={"paved": 0.0, "gravel": 80.0}),
        default_weight=0.2,
        label="軸カ",
        is_published=True,
    ),
    # 重みの違う材料を足す軸（和の単位が定まらない）。
    "axis_optional_terms": AxisDefinition(
        axis_id="axis_optional_terms",
        shape=BreakpointLinearShape(
            terms=[
                MaterialTerm(material="poi_signal_per_km", weight=1.0, required=False),
                MaterialTerm(material="poi_level_crossing_per_km", weight=2.5, required=False),
                MaterialTerm(material="poi_stop_per_km", weight=0.4, required=False),
                MaterialTerm(material="poi_crossing_per_km", weight=0.0, required=False),
            ],
            breakpoints=[(0.0, 0.0), (1.0, 50.0), (4.0, 100.0)],
        ),
        default_weight=0.2,
        label="軸オ",
        is_published=True,
    ),
    # 真偽の材料を符号の違う重みで合成する軸（材料まで分解した内訳を持つ）。重みと割合は応答の他の数と重ならない値にする。
    "axis_boolean_terms": AxisDefinition(
        axis_id="axis_boolean_terms",
        shape=BreakpointLinearShape(
            terms=[
                MaterialTerm(material="lit", weight=-0.29),
                MaterialTerm(material="has_tunnel", weight=0.37),
            ],
            breakpoints=[(-1.0, 0.0), (1.0, 100.0)],
        ),
        default_weight=0.0,
        label="軸ナ",
        is_published=True,
    ),
    # 分類の軸と単位のある材料を合成する軸（内訳に対訳・単位が出る）。
    "axis_mixed_terms": AxisDefinition(
        axis_id="axis_mixed_terms",
        shape=BreakpointLinearShape(
            terms=[
                MaterialTerm(material="axis_categorical", weight=1.0),
                MaterialTerm(material="poi_signal_per_km", weight=2.0),
            ],
            breakpoints=[(0.0, 0.0), (100.0, 100.0)],
        ),
        default_weight=0.0,
        label="軸ミ",
        is_published=True,
    ),
}


@pytest.fixture
def catalog_axes():
    with replaced_axis_definitions(CATALOG_AXES):
        yield


class _CatalogRepository:
    """`/api/axis-catalog`が`RegionService`越しに読むDBの口（データの世代・事故の収録年）の代役。"""

    async def get_data_revisions(self):
        return DataRevisions(derived=None, imported=0)

    async def get_accident_years(self):
        return []


@pytest.fixture
def client():
    """`/api/axis-catalog`を叩く口。このファイルの検証対象は軸カタログの内容で、DBの値は見ない。

    `/api/axis-catalog`は事故の収録年とタイル世代を出すためだけに`RegionService`を経由する。実DBが繋がる環境ではリクエストごとに接続を開き、
    `TestClient`のイベントループをまたいだasyncpg接続がGCされる際にキャンセル用の
    コルーチンが未awaitのまま残る（`RuntimeWarning: coroutine 'Connection._cancel' was
    never awaited`）。DBの口を代役へ固定して、DBの有無でこのファイルの経路が変わらないようにする。
    """
    app.dependency_overrides[get_region_service] = lambda: RegionService(repository=_CatalogRepository())
    yield TestClient(app)
    app.dependency_overrides.pop(get_region_service, None)


def _entries(client) -> dict[str, dict]:
    return {entry["axis_id"]: entry for entry in client.get("/api/axis-catalog").json()["axes"]}


def test_only_the_published_axes_are_served_without_auth(client):
    """下書きの軸が一般の画面へ漏れると、まだ固まっていない軸を利用者が選び、変えも消せもしなくなる。"""
    draft = axis_definition("draft_axis", is_published=False)
    with replaced_axis_definitions({**CATALOG_AXES, draft.axis_id: draft}):
        assert set(_entries(client)) == set(CATALOG_AXES)


def test_each_axis_carries_what_the_domain_derives_for_it(client, catalog_axes):
    """導出の入力違いは domain のテストが持つ。ここは軸ごとの欄へ結果が届くことだけを見る。"""
    entries = _entries(client)

    categorical = entries["axis_categorical"]
    assert categorical["primary_attribute_ids"] == ["surface"]
    signed = entries["axis_way_value_signed"]
    assert (signed["map_paint"]["value"], signed["map_paint"]["unit"]) == (
        {"kind": "signed_material", "material": "gradient_percent"},
        "%",
    )


def test_get_axis_catalog_carries_the_calibration_values_the_client_needs(client, monkeypatch):
    """フロントが使う較正値は、このカタログが**いま効いている値**で運ぶ。

    ビルド時生成物（route-generate-config.json）だけで配ると、管理画面から変えても
    次のデプロイまで画面に届かない。
    """
    param_id = sorted(client.get("/api/axis-catalog").json()["client_tuning"])[0]
    monkeypatch.setitem(tuning.TUNING_VALUES, param_id, 9.5)

    assert client.get("/api/axis-catalog").json()["client_tuning"][param_id] == 9.5


def _axis_reading(material: str):
    """`material`を読む内部軸と、それを読む公開軸。条件は内部軸を辿った葉の材料から決まる。"""
    internal = axis_definition("axis_internal", material=material)
    return {internal.axis_id: internal,
            "axis_any_name": axis_definition("axis_any_name", material=internal.axis_id, is_published=True)}


# 地図が配信の要求へ載せるクエリパラメータは、軸の葉の材料を配るサービスが受け取る条件から決まる。
# 風は時刻を省略できても載せる（利用者が選んだ時刻の風を塗る）。配るサービスの材料を読まない軸には何も載せない。
@pytest.mark.parametrize(
    ("material", "conditions", "requested", "undetermined"),
    [
        ("wind_drag_ratio", {"at", "bearing_deg", "speed_kmh"}, {"at", "bearing_deg", "speed_kmh"}, False),
        ("gradient_percent", {"bearing_deg"}, set(), True),
        ("maxspeed_kmh", set(), set(), False),
    ],
)
def test_get_axis_catalog_names_what_the_map_sends_and_shows_for_an_axis(
    client, material, conditions, requested, undetermined,
):
    """「向きで決まらない」の凡例の行は、配信がその道を返しうる軸だけが持つ（返さない軸に出すと、どの道も入らない行になる）。"""
    with replaced_axis_definitions(_axis_reading(material)):
        response = client.get("/api/axis-catalog")

    (entry,) = response.json()["axes"]
    assert set(entry["dynamic_way_value_conditions"]) == conditions
    assert set(entry["dynamic_way_value_material_conditions"]) == requested
    assert entry["dynamic_way_value_undetermined_by_bearing"] is undetermined
    # 地図は道ごとの材料をこの木で評価する。材料の要求へ載せない条件は、木が読まないと色に効かない。
    formula = WayValueFormula.model_validate(entry["way_value_formula"])
    assert condition_names(formula.value) | condition_names(formula.undetermined) == conditions - requested


def test_get_axis_catalog_includes_raw_value_unit(client, catalog_axes):
    # 得点の隣へ生値を出すための単位（domain/axis_raw_value.py: raw_value_units）。
    # 勾配は単一材料をそのまま使うので%、内部軸を合成する軸は単位が定まらずnull。
    entries = _entries(client)
    assert entries["axis_way_value_signed"]["raw_value_units"]["unit"] == "%"
    # 材料ごとに重みを変えて足す軸は、和がどの単位でも読めない——nullになる。
    assert entries["axis_optional_terms"]["raw_value_units"] == {"unit": None, "total_unit": None}


def test_a_total_unit_without_a_raw_value_unit_cannot_be_served():
    """総量は生値に距離を掛けたものなので、生値の単位の無い総量の単位は掛ける元の無い総量を画面に出させる。"""
    with pytest.raises(ValueError, match="without a raw value unit"):
        RawValueUnits(unit=None, total_unit="回")


def test_get_axis_catalog_includes_material_breakdown(client, catalog_axes):
    # 単位が定まらない軸は、材料まで分解した内訳を持つ（得点だけでは軸単体で判断できない）。並びは正規化重みの降順で、フロントは並べ替えを持たない。
    entries = _entries(client)
    # 単位が定まる軸は分解しない（軸単位の生値で足りる）。
    assert entries["axis_way_value_signed"]["material_breakdown"] == []
    night = entries["axis_boolean_terms"]["material_breakdown"]
    assert [entry["material_id"] for entry in night] == ["has_tunnel", "lit"]
    # 分類の材料はルート結果が値ごとの割合を日本語にする対訳を、数値の材料は単位を運ぶ。
    mixed = entries["axis_mixed_terms"]["material_breakdown"]
    assert [entry["material_id"] for entry in mixed] == ["poi_signal_per_km", SURFACE_ESTIMATE]
    assert mixed[0]["unit"] == MATERIAL_CATALOG["poi_signal_per_km"].unit
    assert mixed[1]["value_labels"] == MATERIAL_CATALOG[SURFACE_ESTIMATE].value_labels


def _numbers(value) -> set[float]:
    if isinstance(value, bool):
        return set()
    if isinstance(value, (int, float)):
        return {round(float(value), 4)}
    if isinstance(value, dict):
        return set().union(*map(_numbers, value.values()))
    if isinstance(value, list):
        return set().union(*map(_numbers, value))
    return set()


def test_get_axis_catalog_does_not_serve_the_material_weights(client, catalog_axes):
    """材料の重みは較正の値で、このカタログは認証なしで誰でも読める（`docs/architecture/data-sources.md`「OSM から作った値と独自の層」）。

    重みも、そこから出る正規化の割合も、応答のどこかに数として出れば読み取れる。
    """
    weights = {-0.29, 0.29, 0.37}
    shares = {round(0.37 / 0.66, 4), round(0.29 / 0.66, 4)}

    assert _numbers(client.get("/api/axis-catalog").json()) & (weights | shares) == set()
