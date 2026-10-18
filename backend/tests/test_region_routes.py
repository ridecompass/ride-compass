"""`api/routers/region.py`——地域の配信（路面・点・土地被覆のタイル、動的材料の値、区間インスペクタ）のHTTPの入口。

確かめるのは、経路ごとの受け渡し（要求のどの値がサービスへ渡り、サービスの結果が応答のどこへ出るか）と、この口が
使う判断: 量ごとの値の範囲（タイル座標・走行方位・想定速度。範囲そのものは domain の型と`domain/region.py:
check_tile_index`が持ち、ここでは入口ごとにそれを使っていることを見る。土地被覆は自分のズーム範囲）、一時的に取れなかった
タイルをキャッシュさせないこと（`_tile_http.py: tile_response`）、宣言に無い点のレイヤー・公開していない軸と木の無い軸の404、
地図のレンズが印の無い軸もタイルの材料から塗ること、軸の葉の材料を配るサービスの条件の欠けの422
（`domain/dynamic_way_values.py: assemble_conditions`）、土地被覆のラスタが無いときの503、
種類ごとに別に数えるレート制限。

差し替えるのは、注入されるサービス（`RegionService`・配信サービス・タイルの材料の読み出し・区間インスペクタ。地図のレンズは
それらの代役で組んだ本物の`AxisWayValueLens`を注入する）・土地被覆のタイルの取得・道路網の読み出し・レート制限の記録だけ。

ここで見ないもの:
- タイルの中身とキャッシュ、区間インスペクタが出す値 → `test_region_service.py`・`test_landcover_tile.py`
- 地図が塗る値への写し方と、軸の木が配信の値と合うこと → `test_dynamic_way_values.py`
- タイルの材料の読み出しとキャッシュ → `test_feature_materials.py`
- 重みの検証（公開軸をすべて明示する等） → `test_routes_generate.py`（同じ`RoutePreferenceWeights`）
- キャッシュの方針の表・圧縮する種類 → `test_cache_policy.py`・`test_response_compression.py`
- レート制限の数え方そのもの → `test_rate_limiter.py`
- 同時実行の上限（semaphore）。待たせるだけで、応答には現れない
"""

import inspect
from datetime import datetime, timezone

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import dependencies
from app.api.cache_policy import BATCH_TILE, NO_STORE
from app.api.dependencies import (
    get_axis_inspector_service,
    get_dedicated_way_value_service,
    get_region_service,
    get_weather_service,
)
from app.domain.attributes import CategoricalColumn
from app.domain.axis_definitions import (
    AXIS_DEFINITIONS,
    AxisDefinition,
    BreakpointLinearShape,
    CategoricalShape,
    MaterialTerm,
    copy_axis_definitions,
)
from app.config import settings
from app.domain.axis_inspector import AxisInspectorAxis, AxisInspectorResult, InspectorComposite, InspectorValues
from app.domain.rain import RAIN_WINDOW_HOURS, rain_window_material_id
from app.domain.region import EDGE_UNIT_MIN_ZOOM, ROAD_TILE_MAX_ZOOM, ROAD_TILE_MIN_ZOOM
from app.infrastructure import rate_limiter
from app.infrastructure.derived_data_meta import DataRevisions
from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.infrastructure.region_tile_cache import TileResponse
from app.domain.dynamic_way_values import (
    FeatureMaterials,
    FeatureSegments,
    WayValueQuery,
    paint_feature_values,
    paint_folded_feature_values,
)
from app.domain.geo import LatLon
from app.domain.route_preference import RoutePreference
from app.domain.gradient import ROAD_BEARING_LEAF
from app.domain.way_value_formula import way_values_from_formula
from app.domain.wind import WIND_DIRECTION_LEAF, WIND_SPEED_LEAF
from app.services.dedicated_way_values import AxisWayValueLens
from app.services.gradient_way_service import GradientWayService
from app.services.weather_service import WeatherService
from app.services.wind_way_service import WindWayService
from app.main import app
from app.domain.landcover import LANDCOVER_TILE_MAX_ZOOM, LANDCOVER_TILE_MIN_ZOOM
from tests.axis_system_fixture import axis_definition, replaced_axis_definitions
from tests.bound_fake import bound

client = TestClient(app)

POINT_LAYER = next(iter(POINT_TILE_LAYERS))


class FakeRegionService:
    def __init__(self, tile_bytes=b"\x00\x01\x02", cacheable=True):
        self._tile_bytes = tile_bytes
        self._cacheable = cacheable
        # 頼まれたタイル（点のレイヤーの名前・路面ならNone、z、x、y）
        self.tile_request = None

    async def get_road_surface_tile(self, z, x, y):
        self.tile_request = (None, z, x, y)
        return TileResponse(self._tile_bytes, cacheable=self._cacheable)

    async def get_point_tile(self, layer, z, x, y):
        self.tile_request = (layer.name, z, x, y)
        return TileResponse(self._tile_bytes, cacheable=self._cacheable)

class FakeAxisInspector:
    """区間インスペクタの代役。受け取ったものを残し、決めた結果を返す。"""

    def __init__(self, result: AxisInspectorResult | None = None):
        self._result = result
        self.request = None

    async def inspect(self, osm_way_id: int, feature_key: str, z: int, x: int, y: int, point: LatLon,
                      query: WayValueQuery, preference: RoutePreference | None) -> AxisInspectorResult | None:
        self.request = (osm_way_id, feature_key, z, x, y, (point.latitude, point.longitude), query, preference)
        return self._result


#: 区間インスペクタの要求が必ず運ぶもの（押した道・押したフィーチャー・押した地点・押したタイル・走行方位）。
INSPECTED = {"osm_way_id": 12345, "feature_key": "12345-0", "point": {"latitude": 35.6, "longitude": 139.4},
             "z": 14, "x": 14551, "y": 6447, "bearing_deg": 90.0}


# 一時的な失敗（DB障害・混雑）で取れなかった空タイルを1時間キャッシュさせると、サーバーが回復した後も
# 利用者のブラウザにはその区画の空白が残り続ける。
@pytest.mark.parametrize(
    ("path", "cacheable", "requested", "cache_control"),
    [
        ("/api/region/road-surface-tiles/14/14551/6447.pbf", True, (None, 14, 14551, 6447), BATCH_TILE),
        ("/api/region/road-surface-tiles/14/14551/6447.pbf", False, (None, 14, 14551, 6447), NO_STORE),
        (f"/api/region/point-tiles/{POINT_LAYER}/14/14551/6447.pbf", False, (POINT_LAYER, 14, 14551, 6447), NO_STORE),
    ],
)
def test_region_tiles_hand_the_services_mvt_over(path, cacheable, requested, cache_control):
    tile = bytes(range(256)) * 40  # 圧縮する大きさを超える
    fake = FakeRegionService(tile_bytes=tile, cacheable=cacheable)
    app.dependency_overrides[get_region_service] = lambda: fake

    try:
        response = client.get(path, headers={"Accept-Encoding": "gzip"})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.content == tile
    assert response.headers["content-type"] == "application/vnd.mapbox-vector-tile"
    assert response.headers["content-encoding"] == "gzip"
    assert response.headers["cache-control"] == cache_control.header()
    assert fake.tile_request == requested


# 外れた値がサービスまで届くと、domain の前提（速度は正・方位は有限・列と行はズームの範囲の中）が崩れて500になるか、
# 在りもしない範囲を引く。入口ごとに、量の型と列・行の上限の検査を使っていることを1行ずつ見る。
@pytest.mark.usefixtures("dedicated_axes")
@pytest.mark.parametrize(
    ("path", "inspected"),
    [
        (f"/api/region/road-surface-tiles/{ROAD_TILE_MIN_ZOOM - 1}/0/0.pbf", None),
        (f"/api/region/road-surface-tiles/{ROAD_TILE_MAX_ZOOM + 1}/0/0.pbf", None),
        ("/api/region/road-surface-tiles/14/-1/6447.pbf", None),
        (f"/api/region/road-surface-tiles/14/{2**14}/6447.pbf", None),
        (f"/api/region/road-surface-tiles/14/14551/{2**14}.pbf", None),
        (f"/api/region/point-tiles/{POINT_LAYER}/{ROAD_TILE_MIN_ZOOM - 1}/0/0.pbf", None),
        (f"/api/region/point-tiles/{POINT_LAYER}/14/{2**14}/6447.pbf", None),
        (f"/api/region/landcover-tiles/10/{2**10}/403.png", None),
        (f"/api/region/dynamic-way-values/axis_way_value_signed/{ROAD_TILE_MIN_ZOOM - 1}/0/0?bearing_deg=0", None),
        (f"/api/region/dynamic-way-values/axis_way_value_signed/14/{2**14}/6447?bearing_deg=0", None),
        ("/api/region/dynamic-way-values/axis_way_value_signed/14/14551/6447?bearing_deg=nan", None),
        ("/api/region/dynamic-way-values/axis_way_value_scored/14/14551/6447?bearing_deg=0&speed_kmh=0", None),
        ("/api/region/dynamic-way-values/axis_way_value_scored/14/14551/6447?bearing_deg=0&speed_kmh=nan", None),
        ("/api/region/axis-inspector", {"z": ROAD_TILE_MAX_ZOOM + 1}),
        ("/api/region/axis-inspector", {"x": 2**14}),
        ("/api/region/axis-inspector", {"bearing_deg": 360.0}),
        ("/api/region/axis-inspector", {"speed_kmh": 0.0}),
    ],
)
def test_region_requests_outside_each_quantitys_range_are_refused(path, inspected):
    app.dependency_overrides[get_region_service] = lambda: FakeRegionService()
    app.dependency_overrides[get_dedicated_way_value_service] = lambda: _lens(SIGNED)
    app.dependency_overrides[get_axis_inspector_service] = lambda: FakeAxisInspector()

    try:
        response = client.get(path) if inspected is None else client.post(path, json={**INSPECTED, **inspected})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 422


def test_region_point_tile_rejects_an_undeclared_layer():
    app.dependency_overrides[get_region_service] = lambda: FakeRegionService()

    try:
        response = client.get("/api/region/point-tiles/no-such-layer/14/14551/6447.pbf")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 404


@pytest.mark.usefixtures("dedicated_axes")
def test_each_kind_of_region_request_is_counted_on_its_own():
    """路面・点のレイヤーごと・動的材料・区間インスペクタは、それぞれ別の回数で上限に当たる。

    回数を分け合うと、1つの種類の取得だけでほかの種類の上限を先に使い切り、地図の別のレイヤーが描かれなくなる。
    """
    limit = settings.road_tile_rate_limit_per_minute
    exhausted_layer, *other_layers = POINT_TILE_LAYERS
    road = "/api/region/road-surface-tiles/14/14551/6447.pbf"
    point = "/api/region/point-tiles/{}/14/14551/6447.pbf"
    app.dependency_overrides[get_region_service] = lambda: FakeRegionService()
    app.dependency_overrides[get_dedicated_way_value_service] = lambda: _lens(SIGNED)
    app.dependency_overrides[get_axis_inspector_service] = lambda: FakeAxisInspector()

    try:
        # 上限-1件は実HTTPを経由せず記録を直接埋め、境界の1回だけ実リクエストで見る。
        for key in ("road-tile", f"{exhausted_layer}-tile"):
            for _ in range(limit - 1):
                rate_limiter.check_rate_limit(f"{key}:testclient", limit)
        exhausted_point = point.format(exhausted_layer)
        exhausted = [client.get(path).status_code for path in (road, road, exhausted_point, exhausted_point)]
        others = [client.get(point.format(layer)).status_code for layer in other_layers]
        others.append(
            client.get(
                "/api/region/dynamic-way-values/axis_way_value_signed/14/14551/6447", params={"bearing_deg": 0}
            ).status_code
        )
        others.append(client.post("/api/region/axis-inspector", json=INSPECTED).status_code)
    finally:
        app.dependency_overrides.clear()

    assert exhausted == [200, 429, 200, 429]
    assert other_layers
    assert others == [200] * len(others)


def test_region_axis_inspector_hands_the_pressed_feature_and_the_maps_conditions_over():
    """押した道・フィーチャー・地点・タイルと、地図が指定している走行方位・時刻・想定速度がサービスへ渡り、その結果が
    応答になる。

    条件が届かないと、1本の道が往復2方向で違う値を持つ材料（勾配・風）を算出できず、地図が色を塗っている軸だけが
    内訳で「データなし」になる。フィーチャー・地点が届かないと、押した区間とは別の区間の値が出る。
    """
    values = InspectorValues(
        axes=[AxisInspectorAxis(axis_id="axis_b", difficulty=75.0, contribution=75.0)],
        composite_difficulty=InspectorComposite(value=75.0, covered_weight_fraction=1.0),
        landcover=None,
    )
    result = AxisInspectorResult(highway="primary", tags={}, segment=values, way=values)
    fake = FakeAxisInspector(result)
    app.dependency_overrides[get_axis_inspector_service] = lambda: fake
    try:
        response = client.post(
            "/api/region/axis-inspector",
            json={**INSPECTED, "at": "2026-09-21T09:00:00+00:00", "speed_kmh": 20.0},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == result.model_dump()
    assert fake.request[:7] == (
        12345, "12345-0", 14, 14551, 6447, (35.6, 139.4),
        WayValueQuery(at=datetime(2026, 9, 21, 9, 0, tzinfo=timezone.utc), bearing_deg=90.0, speed_kmh=20.0),
    )


class FakeDynamicWayValueService:
    """DBを読む配信サービスの代役。配る材料の木と受け取る条件の型は、登録された本物のサービスのものが使われる。"""

    def __init__(self, materials=None, segment_materials=None):
        self._materials = materials if materials is not None else {}
        self._segment_materials = segment_materials
        self.last_request = None

    async def get_way_materials(self, z, x, y, at):
        self.last_request = (z, x, y, at)
        return self._materials

    def segment_materials(self, segments):
        return self._segment_materials


def _served_values(service_type, material_id: str, materials: dict[str, dict], conditions: dict) -> dict:
    """配信のサービスの材料の値（本物の木を、フェイクが配る道ごとの材料と条件で評価した値）。"""
    keys = list(dict.fromkeys(key for values in materials.values() for key in values))
    leaves = {name: [values.get(key, np.nan) for key in keys] for name, values in materials.items()}
    return way_values_from_formula(service_type.material_formula(material_id).formula, keys, leaves, conditions)


class FakeFeatureMaterials:
    """タイルの材料を読む口（`services/feature_materials.py: FeatureMaterialService`）の代役。"""

    def __init__(self, materials: FeatureMaterials | None = None, segments: FeatureSegments | None = None):
        self._materials = materials
        self._segments = segments

    async def materials(self, z, x, y):
        return self._materials

    async def segments(self, z, x, y):
        return self._segments


def _lens(
    axis_id: str, services=None, materials: FeatureMaterials | None = None, segments: FeatureSegments | None = None
) -> AxisWayValueLens:
    """軸の集合は今の`AXIS_DEFINITIONS`。`services`は材料id→配信サービスの代役。"""
    services = services if services is not None else {"gradient_percent": FakeDynamicWayValueService()}
    return AxisWayValueLens(
        axis_id, copy_axis_definitions(), FakeFeatureMaterials(materials, segments), services.__getitem__
    )


SIGNED = "axis_way_value_signed"

#: 地図が配信の値で塗る印を持つ軸。時刻・方位・速度を要るもの（得点を塗る）と、方位だけを要るもの
#: （符号付きの生値を塗る）の2本。
DEDICATED_AXES = {
    "axis_way_value_scored": AxisDefinition(
        axis_id="axis_way_value_scored",
        shape=BreakpointLinearShape(
            terms=[MaterialTerm(material="wind_drag_ratio")],
            breakpoints=[(-1.0, 0.0), (0.0, 20.0), (4.0, 100.0)],
        ),
        default_weight=0.2,
        label="軸ウ",
    ),
    "axis_way_value_signed": AxisDefinition(
        axis_id="axis_way_value_signed",
        shape=BreakpointLinearShape(
            terms=[MaterialTerm(material="gradient_percent")],
            preprocess="abs",
            breakpoints=[(0.0, 0.0), (5.0, 50.0), (10.0, 100.0)],
        ),
        default_weight=0.2,
        label="軸グ",
    ),
}


@pytest.fixture
def dedicated_axes():
    with replaced_axis_definitions(DEDICATED_AXES):
        yield


# 応答はサービスの道ごとの材料ではなく**地図が塗る値**（domain/dynamic_way_values.py: paint_feature_values）。写し方の
# 検証はtest_dynamic_way_values.pyが持つため、ここでは軸の折れ点を写経せず、材料の値を同じ関数へ通した結果と突き合わせる
# ——見たいのは「エンドポイントがこの写しを通すか」。要るクエリは軸の葉の材料を配るサービスが受け取る条件の型が決め、
# 型に無いもの（勾配の時刻・速度）は省いても配る。
@pytest.mark.usefixtures("dedicated_axes")
@pytest.mark.parametrize(
    ("axis_id", "material_id", "service_type", "materials", "params", "conditions"),
    [
        (
            "axis_way_value_scored",
            "wind_drag_ratio",
            WindWayService,
            {WIND_SPEED_LEAF: {"1": 6.0, "2": 3.0}, WIND_DIRECTION_LEAF: {"1": 90.0, "2": 270.0}},
            {"bearing_deg": 90, "speed_kmh": 20.0, "at": "2026-08-30T09:00:00"},
            {"bearing_deg": 90.0, "speed_kmh": 20.0},
        ),
        (
            "axis_way_value_signed",
            "gradient_percent",
            GradientWayService,
            {"gradient_percent": {"1": 2.0, "2": -1.5}, ROAD_BEARING_LEAF: {"1": 90.0, "2": 270.0}},
            {"bearing_deg": 90},
            {"bearing_deg": 90.0},
        ),
    ],
)
def test_region_dedicated_way_values_returns_map_values_json(
    axis_id, material_id, service_type, materials, params, conditions
):
    raw = _served_values(service_type, material_id, materials, conditions)
    expected = paint_feature_values(axis_id, AXIS_DEFINITIONS, list(raw), {}, {material_id: raw}, as_difficulty=False)
    fake = FakeDynamicWayValueService(materials=materials)
    app.dependency_overrides[get_dedicated_way_value_service] = lambda: _lens(axis_id, {material_id: fake})

    try:
        response = client.get(f"/api/region/dynamic-way-values/{axis_id}/14/14551/6447", params=params)
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == expected
    at = datetime.fromisoformat(params["at"]) if "at" in params else None
    assert fake.last_request == (14, 14551, 6447, at)


# 引いた地図（道1本で塗るズーム）では、区間から畳む軸の値を、フィーチャーごとの区間の材料と配信のサービスが配る
# 区間の材料から畳んで返す。畳み方はtest_dynamic_way_values.pyが持つため、同じ関数へ通した結果と突き合わせる。
@pytest.mark.usefixtures("dedicated_axes")
def test_region_dedicated_way_values_folds_the_segments_of_a_way_on_the_zoomed_out_map():
    grades = np.array([8.0, -8.0])
    segments = FeatureSegments(feature_keys=("1", "1"), distance_m=np.full(2, 100.0), feature_bearing_deg=np.zeros(2),
                               columns={"gradient_percent": grades})
    raw = {"1": 0.0}
    expected = paint_folded_feature_values(
        SIGNED, AXIS_DEFINITIONS, list(raw), {}, {"gradient_percent": raw}, segments, {"gradient_percent": grades},
        as_difficulty=False)
    fake = FakeDynamicWayValueService(
        materials={"gradient_percent": raw, ROAD_BEARING_LEAF: {"1": 0.0}},
        segment_materials={"gradient_percent": grades, ROAD_BEARING_LEAF: np.zeros(2)})
    app.dependency_overrides[get_dedicated_way_value_service] = lambda: _lens(
        SIGNED, {"gradient_percent": fake}, segments=segments)

    try:
        response = client.get(
            f"/api/region/dynamic-way-values/{SIGNED}/{EDGE_UNIT_MIN_ZOOM - 1}/7275/3225", params={"bearing_deg": 0})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == expected != raw


#: 区間から畳み、走行方位だけでは選べない材料（風）も読む軸。地図へ木を配れない。
FOLDED_WITH_WIND = AxisDefinition(
    axis_id="axis_way_value_folded_wind",
    shape=BreakpointLinearShape(
        terms=[MaterialTerm(material="gradient_percent"), MaterialTerm(material="wind_drag_ratio")],
        breakpoints=[(0.0, 0.0), (10.0, 100.0)],
    ),
    default_weight=0.2,
    label="軸カ",
)


@pytest.mark.usefixtures("dedicated_axes")
def test_region_way_materials_are_the_same_whatever_heading_and_speed_the_map_has():
    """地図は道ごとの材料を走行方位・想定速度に依らずに1回取り、向きと速度を変えるたびに木で値を求め直す。材料が
    向きで変わると、向きを変えた地図が前の向きの材料で塗る。時刻は時刻に依る材料（風）へ渡る。"""
    fake = FakeDynamicWayValueService(materials={
        "gradient_percent": {"1": 2.0, "2": -1.5}, ROAD_BEARING_LEAF: {"1": 90.0}})
    app.dependency_overrides[get_dedicated_way_value_service] = lambda: _lens(SIGNED, {"gradient_percent": fake})

    try:
        responses = [
            client.get(f"/api/region/way-materials/{SIGNED}/14/14551/6447",
                       params={"at": "2026-08-30T09:00:00", **params})
            for params in ({}, {"bearing_deg": 0, "speed_kmh": 20.0}, {"bearing_deg": 180, "speed_kmh": 30.0})
        ]
    finally:
        app.dependency_overrides.clear()

    assert [response.status_code for response in responses] == [200] * 3
    bodies = [response.json() for response in responses]
    assert bodies[0] == bodies[1] == bodies[2]
    assert bodies[0]["1"][ROAD_BEARING_LEAF] == 90.0
    assert ROAD_BEARING_LEAF not in bodies[0]["2"]
    assert fake.last_request == (14, 14551, 6447, datetime(2026, 8, 30, 9, 0))


@pytest.mark.parametrize(
    ("axes", "axis_id", "detail"),
    [
        ({**DEDICATED_AXES, FOLDED_WITH_WIND.axis_id: FOLDED_WITH_WIND}, FOLDED_WITH_WIND.axis_id, "配りません"),
        (DEDICATED_AXES, "axis_absent", "公開している軸ではありません"),
    ],
    ids=["木の無い軸", "公開していない軸"],
)
def test_region_way_materials_are_not_found_for_an_axis_the_map_cannot_compute(axes, axis_id, detail):
    """木の無い軸の材料を配っても、地図はそこから値を求められない（その軸は配信の値で塗る）。"""
    services = {"gradient_percent": FakeDynamicWayValueService(), "wind_drag_ratio": FakeDynamicWayValueService()}
    with replaced_axis_definitions(axes):
        app.dependency_overrides[get_dedicated_way_value_service] = (
            lambda: _lens(axis_id, services) if axis_id in axes else None)
        try:
            response = client.get(f"/api/region/way-materials/{axis_id}/14/14551/6447")
        finally:
            app.dependency_overrides.clear()

    assert response.status_code == 404
    assert detail in response.json()["detail"]


#: 地図を配信で塗る印の無い軸。タグから引く分類の材料を読む軸と、それを内部軸として読む軸。
TAG_AXES = {
    "axis_tag_internal": AxisDefinition(
        axis_id="axis_tag_internal",
        shape=CategoricalShape(material="surface_class", mapping={"paved": 10.0, "unpaved": 90.0}),
        default_weight=0.0,
        label="軸シ",
    ),
    "axis_tag_reference": AxisDefinition(
        axis_id="axis_tag_reference",
        shape=BreakpointLinearShape(
            terms=[MaterialTerm(material="axis_tag_internal")], breakpoints=[(0.0, 0.0), (100.0, 100.0)]
        ),
        default_weight=0.2,
        label="軸サ",
        is_published=True,
    ),
}


# 配信は印の無い軸にも、タイルの材料から探索と同じ評価で値を返す。返さないと、画面がその軸を配信で塗る形へ
# 切り替えたとき、タイルから式を組んで塗っていた道がすべて「データなし」になる。道のタグだけで決まる軸は、引いた地図
# （道1本で塗るズーム）でも区間を読まずに塗る（区間を読む口は、ここでは取込範囲外を答える）。
@pytest.mark.parametrize("z", [EDGE_UNIT_MIN_ZOOM, EDGE_UNIT_MIN_ZOOM - 1])
def test_region_dedicated_way_values_paints_an_axis_from_the_materials_of_the_tile(z):
    materials = FeatureMaterials(
        feature_keys=("1", "2", "3"),
        columns={"surface_class": CategoricalColumn.encode(["paved", "unpaved", None])},
    )
    with replaced_axis_definitions(TAG_AXES):
        app.dependency_overrides[get_dedicated_way_value_service] = lambda: _lens("axis_tag_reference", {}, materials)
        try:
            response = client.get(f"/api/region/dynamic-way-values/axis_tag_reference/{z}/7275/3225")
        finally:
            app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == {"1": 10.0, "2": 90.0}


@pytest.mark.usefixtures("dedicated_axes")
def test_region_dedicated_way_values_names_the_missing_condition():
    fake = FakeDynamicWayValueService()
    app.dependency_overrides[get_dedicated_way_value_service] = lambda: _lens(
        "axis_way_value_scored", {"wind_drag_ratio": fake}
    )

    try:
        response = client.get(
            "/api/region/dynamic-way-values/axis_way_value_scored/14/14551/6447", params={"speed_kmh": 20.0}
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 422
    assert "bearing_deg" in response.json()["detail"]


class UncoveredRepository:
    """どのタイルも取込範囲外と答えるDBの代役。"""

    async def get_data_revisions(self):
        return DataRevisions(derived=1, imported=1)

    async def get_accident_years_covered(self):
        return 1

    async def get_feature_gradient_inputs_in_tile(self, *args, **kwargs):
        inspect.signature(RoadGraphRepository.get_feature_gradient_inputs_in_tile).bind(self, *args, **kwargs)
        return None

    async def get_feature_materials_in_tile(self, *args, **kwargs):
        inspect.signature(RoadGraphRepository.get_feature_materials_in_tile).bind(self, *args, **kwargs)
        return None


class NoRainHistoryWeather:
    """雨の観測の履歴が無いと答える気象サービスの代役。"""

    async def get_station_rain_materials(self, *args, **kwargs):
        inspect.signature(WeatherService.get_station_rain_materials).bind(self, *args, **kwargs)
        return None


# 実際のget_dedicated_way_value_serviceを通し、初めて見る名前の公開軸が、配信のサービスの材料（勾配、要求の気象サービスを
# 読む雨）でもタイルの材料（制限速度）でも配信されること・公開していない軸と無い軸は404になることを見る（Noneは軸を置かない）。
@pytest.mark.parametrize(
    ("material", "published", "status"),
    [
        ("gradient_percent", True, 200),
        (rain_window_material_id(RAIN_WINDOW_HOURS[0]), True, 200),
        ("maxspeed_kmh", True, 200),
        ("maxspeed_kmh", False, 404),
        (None, True, 404),
    ],
)
def test_region_dedicated_way_values_serves_every_published_axis(monkeypatch, material, published, status):
    if material is not None:
        axis = axis_definition("axis_new_name", material=material, is_published=published)
        monkeypatch.setitem(AXIS_DEFINITIONS, "axis_new_name", axis)
    monkeypatch.setattr(dependencies, "RoadGraphRepository", lambda session: UncoveredRepository())
    app.dependency_overrides[get_weather_service] = NoRainHistoryWeather

    try:
        response = client.get("/api/region/dynamic-way-values/axis_new_name/14/14551/6447", params={"bearing_deg": 0})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == status


# ---- 土地被覆ラスタタイル（`/api/region/landcover-tiles`） ----


@pytest.fixture
def landcover_tiles():
    """配信の口が呼ぶタイルの取得（サービス）の代役。返す値は`result`で決め、呼ばれた座標を`calls`に残す。"""
    state = {"result": TileResponse(b"png-bytes"), "calls": []}

    async def fake(z, x, y):
        state["calls"].append((z, x, y))
        return state["result"]

    reader = bound(dependencies.get_landcover_tile_reader(), fake)
    app.dependency_overrides[dependencies.get_landcover_tile_reader] = lambda: reader
    yield state
    app.dependency_overrides.clear()


def test_landcover_tile_endpoint_returns_the_tile_as_png(landcover_tiles):
    response = client.get("/api/region/landcover-tiles/10/905/403.png")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content == b"png-bytes"
    assert landcover_tiles["calls"] == [(10, 905, 403)]


def test_landcover_tile_endpoint_without_raster_reports_unavailable(landcover_tiles):
    # ラスタが1枚も無いのは「範囲外で空」ではない。空を返すと、地図のチップは正常なのに白紙になる
    landcover_tiles["result"] = None

    assert client.get("/api/region/landcover-tiles/10/905/403.png").status_code == 503


@pytest.mark.usefixtures("landcover_tiles")
@pytest.mark.parametrize(
    ("z", "status"),
    [
        (LANDCOVER_TILE_MIN_ZOOM - 1, 422),
        (LANDCOVER_TILE_MIN_ZOOM, 200),
        (LANDCOVER_TILE_MAX_ZOOM, 200),
        (LANDCOVER_TILE_MAX_ZOOM + 1, 422),
    ],
)
def test_landcover_tile_endpoint_serves_only_its_own_zoom_range(z, status):
    assert client.get(f"/api/region/landcover-tiles/{z}/1/1.png").status_code == status


#: 重みを送る検査に使う公開軸。
_WEIGHTED_AXES = {
    axis_id: axis_definition(axis_id, is_published=True) for axis_id in ("axis_p", "axis_q")
}


@pytest.fixture
def weighted_axes():
    with replaced_axis_definitions(_WEIGHTED_AXES):
        yield


@pytest.mark.usefixtures("weighted_axes")
def test_region_axis_inspector_uses_the_weights_it_is_sent():
    """合成は利用者がいま設定している重みで計算する。送らなければ既定の重み。"""
    fake = FakeAxisInspector()
    app.dependency_overrides[get_axis_inspector_service] = lambda: fake
    weights = {axis_id: 0.0 for axis_id in _WEIGHTED_AXES}
    try:
        sent = client.post("/api/region/axis-inspector", json={**INSPECTED, "route_preference": weights})
        sent_preference = fake.request[-1]
        omitted = client.post("/api/region/axis-inspector", json=INSPECTED)
    finally:
        app.dependency_overrides.clear()

    assert sent.status_code == 200
    assert sent_preference.weights == weights
    assert omitted.status_code == 200
    assert fake.request[-1] is None
