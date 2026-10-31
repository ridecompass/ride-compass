"""`api/routers/axis_admin.py`——軸スタジオの管理API（書き込み時の検証・例外の変換）。

ここで見ないもの:
- 軸そのものの不変条件（折れ点・段の境界・段ラベル）と公開の不変性・材料の排他、軸の外（材料カタログ・
  ほかの軸）に照らす値の不変条件（`check_axis_definition`）の中身 → `test_axis_definitions.py`
- 書き込みの本体（DBへの反映と`AXIS_DEFINITIONS`の差し替え） → `test_axis_registry_service.py`
- 下書きの点数の計算と段の境界の並びの検証の入力違い → `test_axis_definitions.py`
- 分布の計算 → `test_value_distribution.py`
- 認可（どの口もBasic認証の依存を持つこと・その依存が拒むこと） → `test_admin_route_authorization.py`
- DBの失敗の503 → `test_admin_db_unavailable.py`
- 道の点数の評価そのもの（材料の値から地図が塗る値への写し・条件の欠けの判定・区間から畳むこと） → `test_dynamic_way_values.py`・
  `test_region_routes.py`

ここで見るのは、口ごとの受け渡し（無い軸・断られた書き込みを状態コードへ変えること）と、ルーターが自分で持つ
検証（URLと本文の軸の一致）。下書きの道の点数は、同じ材料で組んだ配信のレンズの値と突き合わせる。

**軸の集合は差し替える**（`tests/axis_system_fixture.py: replaced_axis_definitions`）。注入するサービス（軸の書き込み・
分布の計算（DB）・下書きのレンズが読むタイルの材料）は依存の差し替えで与える。どれも読むだけなので、応答を差し替えるだけで呼ばれ方は見ない。
材料カタログは本物を通し、材料は性質ごとに本物のカタログから選ぶ。
"""

import asyncio

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routers import axis_admin
from app.domain.axis_definitions import AXIS_DEFINITIONS
from app.domain.dynamic_way_values import FeatureMaterials, WayValueQuery
from app.domain.material_catalog import MATERIAL_CATALOG
from app.domain.region import EDGE_UNIT_MIN_ZOOM
from app.domain.value_distribution import ValueDistribution
from app.services.dedicated_way_values import (
    DEDICATED_WAY_VALUE_SERVICES,
    draft_axis_way_value_lens,
    services_by_material,
)
from tests.admin_auth import AUTH_HEADERS
from tests.axis_system_fixture import replaced_axis_definitions
from tests.material_fixture import stored_materials
from tests.way_value_lens_fixture import FakeFeatureMaterials, axis_way_value_lens


BASE = "/api/admin/axis-definitions"
NUM_A = stored_materials("numeric")[0]
REFERENCED_AXIS = "ref"


def linear_shape(*materials):
    return {
        "kind": "breakpoint_linear",
        "terms": [{"material": m} for m in materials],
        "breakpoints": [[0, 0], [10, 100]],
    }


def payload(axis_id="a", **fields):
    body = {"axis_id": axis_id, "label": "軸A", "default_weight": 1.0, "shape": linear_shape(NUM_A)}
    body.update(fields)
    return body


def stored(axis_id="a", **fields):
    return axis_admin.AxisDefinition.model_validate(payload(axis_id, **fields))


class FakeAxisRegistry:
    """`AxisRegistryAdminService`の代役。受けた呼び出しを記録し、`errors`に置いた例外を送出する。"""

    def __init__(self):
        self.axes: dict[str, axis_admin.AxisDefinition] = {}
        self.calls: list[tuple] = []
        self.errors: dict[str, Exception] = {}

    def _record(self, name, *args):
        self.calls.append((name, *args))
        if name in self.errors:
            raise self.errors[name]

    @property
    def writes(self) -> list[tuple]:
        """受けた呼び出しのうち書き込み（応答に重みの割合を添えるための一覧の読み取りを除く）。"""
        return [call for call in self.calls if call[0] != "list_all"]

    async def list_all(self):
        self._record("list_all")
        return dict(self.axes)

    async def create(self, definition):
        self._record("create", definition)
        self.axes[definition.axis_id] = definition
        return dict(self.axes)

    async def update(self, axis_id, definition):
        self._record("update", axis_id, definition)
        if axis_id not in self.axes:
            raise KeyError(axis_id)
        self.axes[axis_id] = definition
        return dict(self.axes)

    async def delete(self, axis_id):
        self._record("delete", axis_id)
        self.axes.pop(axis_id)

    async def unpublish(self, axis_id):
        self._record("unpublish", axis_id)
        self.axes[axis_id] = self.axes[axis_id].model_copy(update={"is_published": False})
        return dict(self.axes)


@pytest.fixture
def registry():
    return FakeAxisRegistry()


class FakePreview:
    """分布の計算（`AxisPreviewService`）の代役。"""

    async def raw_value_distribution(self, shape):
        return ValueDistribution(sample_ways=3, total_km=1.5, quantiles={"p50": 2.0}, bins=[(0.0, 4.0, 1.0)])


@pytest.fixture
def preview():
    return FakePreview()


@pytest.fixture
def referenced_axis():
    """管理APIが照らす軸の集合（起動時にDBから読んだもの）は、ほかの軸が参照する軸1本だけ。"""
    with replaced_axis_definitions({REFERENCED_AXIS: stored(REFERENCED_AXIS)}):
        yield


@pytest.fixture
def app(registry, preview, referenced_axis):
    app = FastAPI()
    app.include_router(axis_admin.router)
    app.dependency_overrides[axis_admin.get_axis_registry_admin_service] = lambda: registry
    app.dependency_overrides[axis_admin.get_axis_preview_service] = lambda: preview
    return app


@pytest.fixture
def client(app, admin_credentials):
    return TestClient(app, headers=AUTH_HEADERS)


class TestRead:
    def test_list_returns_every_axis(self, client, registry):
        registry.axes = {"a": stored("a"), "b": stored("b", label="軸B")}

        body = client.get(BASE).json()

        assert [(item["axis_id"], item["label"]) for item in body] == [("a", "軸A"), ("b", "軸B")]

    def test_an_axis_whose_material_left_the_catalog_can_still_be_read(self, client, registry):
        """読み出しは保存済みの内容を返すだけで、書き込み時の検証をやり直さない。"""
        registry.axes["a"] = stored(shape=linear_shape("retired"))

        response = client.get(BASE + "/a")

        assert (response.status_code, response.json()["axis_id"]) == (200, "a")


class TestWrite:
    def test_create_stores_a_plain_axis_definition_and_returns_it(self, client, registry):
        """ペイロードの型のまま渡すと、公開後の見た目だけの更新を判定する等価比較が型の違いで
        常に不一致になる。"""
        response = client.post(BASE, json=payload())

        assert response.status_code == 201
        assert response.json()["axis_id"] == "a"
        ((name, definition),) = registry.writes
        assert (name, type(definition)) == ("create", axis_admin.AxisDefinition)

    def test_update_stores_a_plain_axis_definition_under_the_axis_id(self, client, registry):
        registry.axes["a"] = stored()

        response = client.put(BASE + "/a", json=payload(default_weight=2.0))

        assert response.status_code == 200
        ((name, axis_id, definition),) = registry.writes
        assert (name, axis_id, type(definition), definition.default_weight) == (
            "update",
            "a",
            axis_admin.AxisDefinition,
            2.0,
        )

    def test_update_whose_body_names_another_axis_is_a_400(self, client, registry):
        response = client.put(BASE + "/a", json=payload("b"))

        assert response.status_code == 400
        assert registry.calls == []

    @pytest.mark.parametrize(
        ("method", "path", "body"),
        [
            ("GET", BASE + "/a", None),
            ("PUT", BASE + "/a", payload()),
            ("DELETE", BASE + "/a", None),
            ("POST", BASE + "/a/unpublish", None),
        ],
    )
    def test_an_operation_on_an_unknown_axis_is_a_404(self, client, method, path, body):
        assert client.request(method, path, json=body).status_code == 404

    @pytest.mark.parametrize(
        ("method", "path", "body", "operation"),
        [
            ("POST", BASE, payload(), "create"),
            ("PUT", BASE + "/a", payload(), "update"),
            ("DELETE", BASE + "/a", None, "delete"),
        ],
    )
    def test_an_operation_refused_by_the_registry_is_a_409(self, client, registry, method, path, body, operation):
        registry.axes["a"] = stored()
        registry.errors[operation] = ValueError("公開済みの軸は変更できない")

        response = client.request(method, path, json=body)

        assert (response.status_code, response.json()["detail"]) == (409, "公開済みの軸は変更できない")

    def test_delete_is_a_204(self, client, registry):
        registry.axes["a"] = stored()

        assert client.delete(BASE + "/a").status_code == 204
        assert "a" not in registry.axes

    def test_unpublish_returns_the_axis_as_stored_afterwards(self, client, registry):
        registry.axes["a"] = stored(is_published=True)

        body = client.post(BASE + "/a/unpublish").json()

        assert (body["axis_id"], body["is_published"]) == ("a", False)


class TestPayloadValidation:
    """本文の検証。拒否は422で、レジストリへは届かない。値の不変条件は`check_axis_definition`へ渡す。"""

    def test_rejected(self, client, registry):
        response = client.post(BASE, json=payload(shape=linear_shape("ghost")))

        assert response.status_code == 422
        assert "存在しない材料・軸を指しています（ghost）" in response.json()["detail"][0]["msg"]
        assert registry.calls == []

    def test_accepted(self, client):
        assert client.post(BASE, json=payload(shape=linear_shape(REFERENCED_AXIS))).status_code == 201


class TestPreviews:
    def test_distribution_answers_what_was_computed_for_the_draft_shape(self, client):
        body = client.post(BASE + "/preview-distribution", json={"shape": linear_shape(NUM_A)}).json()

        assert body == {
            "sample_ways": 3,
            "total_km": 1.5,
            "quantiles": {"p50": 2.0},
            "bins": [[0.0, 4.0, 1.0]],
        }

    def test_scores_of_a_draft(self, client):
        shape = linear_shape(NUM_A)

        body = client.post(BASE + "/preview-scores", json={"shape": shape, "xs": [2.5, 20.0]}).json()

        assert body == {"scores": [25.0, 100.0]}

    def test_calibration_of_a_draft_answers_its_map_bands_and_whether_it_averages_density(self, client):
        """段の境界は下書きの折れ点から導いたもの。密度の軸の画面は、0点の端を動かさない。"""
        additive = next(m for m in stored_materials("numeric") if MATERIAL_CATALOG[m].additive)
        definition = payload(shape={**linear_shape(additive), "breakpoints": [[0, 0], [8, 100]]})

        body = client.post(BASE + "/preview-calibration", json={"definition": definition}).json()

        assert body["averages_density"] is True
        assert body["map_paint"]["thresholds"] == [100.0]


#: タイルの材料から読む数値の材料（配信のサービスが配る材料を除く）。
TILE_A, TILE_B = [m for m in stored_materials("numeric") if m not in services_by_material(DEDICATED_WAY_VALUE_SERVICES)][:2]
TILE = {"z": EDGE_UNIT_MIN_ZOOM, "x": 7275, "y": 3225}
#: 軸`a`が読む材料の、タイルの道ごとの値。
TILE_MATERIALS = FeatureMaterials(feature_keys=("1", "2"), columns={TILE_A: np.array([2.0, 5.0])})


@pytest.fixture
def way_axes(app):
    """軸`a`（`TILE_A`を読む）と`b`（`TILE_B`を読む）の集合。下書きの値と、同じ材料で組んだ配信の値を比べる。"""
    axes = {"a": stored("a", shape=linear_shape(TILE_A), is_published=True), "b": stored("b", shape=linear_shape(TILE_B))}
    materials = FakeFeatureMaterials(TILE_MATERIALS)
    app.dependency_overrides[axis_admin.get_draft_way_value_lens_builder] = lambda: (
        lambda axis_id, shape: draft_axis_way_value_lens(axis_id, shape, materials, {}.__getitem__))
    with replaced_axis_definitions(axes):
        yield lambda: asyncio.run(
            axis_way_value_lens("a", materials).values(
                TILE["z"], TILE["x"], TILE["y"], WayValueQuery(at=None, bearing_deg=None, speed_kmh=None)))


def preview_body(shape, axis_id="a", **fields):
    return {"axis_id": axis_id, "shape": shape, **TILE, **fields}


# 較正の地図は、保存されている折れ点では地図の配信と同じ色で塗り、下書きを動かすとその折れ点の色へ変わる。下書きを
# 問い合わせても、公開中の軸で塗る利用者の地図は変わらない。
class TestWayValuesPreview:
    def test_published_breakpoints_answer_what_the_map_serves(self, client, way_axes):
        served = way_axes()

        response = client.post(BASE + "/preview-way-values", json=preview_body(linear_shape(TILE_A)))

        assert response.status_code == 200
        assert response.json() == served == {"1": 20.0, "2": 50.0}

    def test_draft_breakpoints_change_only_the_answer(self, client, way_axes):
        draft = {**linear_shape(TILE_A), "breakpoints": [[0, 100], [10, 0]]}
        served = way_axes()
        published = dict(AXIS_DEFINITIONS)

        response = client.post(BASE + "/preview-way-values", json=preview_body(draft))

        assert response.json() == {"1": 80.0, "2": 50.0}
        assert way_axes() == served
        assert AXIS_DEFINITIONS == published

    @pytest.mark.usefixtures("way_axes")
    @pytest.mark.parametrize(
        ("body", "status_code", "detail"),
        [
            (preview_body(linear_shape(TILE_A), axis_id="missing"), 404, None),
            # 保存の判定が断る下書き（ほかの軸の材料を読む）は、その理由の文で断る。
            (preview_body(linear_shape(TILE_B)), 422, "使っています"),
            # 向きで符号の変わる材料は、配信と同じく走行方位が無ければ求めない。
            (preview_body(linear_shape("gradient_percent")), 422, "bearing_deg"),
        ],
    )
    def test_refused_previews(self, client, body, status_code, detail):
        response = client.post(BASE + "/preview-way-values", json=body)

        assert response.status_code == status_code
        if detail is not None:
            assert detail in response.json()["detail"]
