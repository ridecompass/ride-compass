"""`services/region_service.py`——地域のレイヤー（路面・点のタイル）の配信と、区間インスペクタ・事故の収録年。

確かめるのは、焼けなかったタイル（範囲外・DB障害）の空タイルとブラウザに持たせてよいか、焼いたタイルを世代付きの鍵で
ディスクへ残すか、区間インスペクタ（`AxisInspectorService`）が押した区間と道1本の値を地図の配信と同じ値で出し、渡された
重みで合成すること、DB障害の倒し方。差し替えるのはDBの口と、インスペクタが読むタイルの材料・配信のサービスだけ。

ここで見ないもの:
- キャッシュの読み書きの骨格 → `test_region_tile_cache.py`
- 世代の文字列の組み立て → `test_cache_identity.py`。世代をTTLで読み直すこと → `test_derived_data_revision_service.py`
- 焼き込むSQLが出す点 → `test_point_tiles.py`
- HTTPの受け渡し → `test_region_routes.py`
- 地図の配信が塗る値の求め方 → `test_dynamic_way_values.py`
"""

import numpy as np
import pytest

from app.config import settings
from app.domain.attributes import CategoricalColumn
from app.domain.axis_definitions import BreakpointLinearShape, CategoricalShape, MaterialTerm, copy_axis_definitions
from app.domain.dynamic_way_values import FeatureMaterials, FeatureSegments, WayValueQuery
from app.domain.geo import LatLonPoint
from app.domain.region import EDGE_UNIT_MIN_ZOOM, tile_bounds_lonlat
from app.domain.route_preference import RoutePreference
from app.infrastructure.derived_data_meta import DataRevisions
from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS
from app.infrastructure.vector_tile import ROAD_SURFACE_LAYER_NAME, encode_empty_tile
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.services.dedicated_way_values import AxisWayValueLens
from app.services.gradient_way_service import GradientConditions
from app.services.region_service import AxisInspectorService, RegionService
from tests.axis_system_fixture import replaced_axis_definitions, shaped_axis


Z, X, Y = 14, 14551, 6447
POINT_LAYER = next(iter(POINT_TILE_LAYERS.values()))


class _TileRepository:
    """路面・点のMVTを焼く口とデータの世代だけを持つフェイク。取込範囲外はNone、DB障害は例外。"""

    def __init__(self, tile: bytes | None = None, error: Exception | None = None, derived: int | None = 1):
        self.tile = tile
        self.error = error
        self.derived = derived

    async def get_data_revisions(self):
        return DataRevisions(derived=self.derived, imported=1)

    async def _answer(self):
        if self.error is not None:
            raise self.error
        return self.tile

    async def get_road_surface_tile_mvt(self, z, x, y, bbox):
        return await self._answer()

    async def get_tile_mvt(self, sql, layer_name, z, x, y, bbox):
        return await self._answer()


def _road_surface_tile(service):
    return service.get_road_surface_tile(Z, X, Y)


def _point_tile(service):
    return service.get_point_tile(POINT_LAYER, Z, X, Y)


@pytest.mark.parametrize(("serve", "error", "empty_tile", "cacheable"), [
    (_road_surface_tile, None, encode_empty_tile(ROAD_SURFACE_LAYER_NAME), True),
    # 一時的な失敗の空タイルをブラウザが持つと、回復した後もその区画の空白が残る。
    (_road_surface_tile, ConnectionRefusedError("db down"), encode_empty_tile(ROAD_SURFACE_LAYER_NAME), False),
    # 点のレイヤーも同じ道で配る。空タイルは自分のsource-layerを名乗る。
    (_point_tile, None, encode_empty_tile(POINT_LAYER.source_layer), True),
], ids=["範囲外", "DB障害", "点のレイヤー"])
async def test_a_tile_that_cannot_be_made_is_empty_and_browsers_may_keep_only_an_uncovered_one(
        serve, error, empty_tile, cacheable):
    service = RegionService(repository=_TileRepository(tile=None, error=error))

    tile = await serve(service)

    assert (tile.content, tile.cacheable) == (empty_tile, cacheable)


@pytest.mark.parametrize(("before", "after", "kept"), [
    (1, 1, True),
    (1, 2, False),
    (None, None, False),
], ids=["同じ世代", "派生を作り直した", "世代が分からない"])
async def test_a_baked_tile_is_served_from_disk_only_while_its_generation_is_known_and_unchanged(
        monkeypatch, before, after, kept):
    """世代はタイルを配る経路が自分で読む。起動後に誰もカタログを取っていなくても、焼いたタイルは世代付きの鍵で
    ディスクへ残り、世代が変わると焼き直す。世代が分からないうちに焼いたタイルは残さない——後で世代が分かっても
    古いと判定できない。"""
    monkeypatch.setattr(settings, "derived_data_revision_check_interval_seconds", 0.0)
    repository = _TileRepository(tile=b"first", derived=before)
    service = RegionService(repository=repository)
    await _road_surface_tile(service)

    repository.tile, repository.derived = b"second", after
    tile = await _road_surface_tile(service)

    assert tile.content == (b"first" if kept else b"second")


# --- 区間インスペクタ ---


#: 道1本で焼くタイルと、その中の区間で焼くタイル。押した道の鍵と、その道の区間の鍵。
WAY_TILE = (EDGE_UNIT_MIN_ZOOM - 1, 7275, 3225)
EDGE_TILE = (EDGE_UNIT_MIN_ZOOM, 2 * 7275 + 1, 2 * 3225)
WAY, SEGMENT = "12345", "12345-1"
#: 区間で焼くタイルの中の地点（押した地点に最も近い区間の上の点として返す）。
EDGE_TILE_BOUNDS = tile_bounds_lonlat(*EDGE_TILE)
ON_SEGMENT = (
    (EDGE_TILE_BOUNDS.min_latitude + EDGE_TILE_BOUNDS.max_latitude) / 2,
    (EDGE_TILE_BOUNDS.min_longitude + EDGE_TILE_BOUNDS.max_longitude) / 2,
)

#: 区間ごとに値の違う材料（勾配）を読む軸と、道のタグを読む軸。どちらも得点を塗る。
INSPECTED_AXES = {
    "axis_grade": shaped_axis(
        BreakpointLinearShape(terms=[MaterialTerm(material="gradient_percent")],
                              breakpoints=[(-10.0, 100.0), (0.0, 0.0), (10.0, 50.0)]),
        axis_id="axis_grade", is_published=True),
    "axis_surface": shaped_axis(
        CategoricalShape(material="surface_class", mapping={"paved": 10.0, "unpaved": 90.0}),
        axis_id="axis_surface", is_published=True),
}


class _InspectedWayRepository(RoadGraphRepository):
    """押した道の読み出しだけに答えるなりすまし（実セッションを持たない）。区間を選ぶ空間の照合は実DBで
    `test_feature_materials_in_tile.py`が見る。"""

    def __init__(self):
        pass

    async def get_way_tags_by_osm_way_id(self, osm_way_id):
        return ("primary", {})

    async def get_nearest_way_segment(self, osm_way_id, latitude, longitude):
        return (SEGMENT, *ON_SEGMENT)

    async def get_feature_landcover(self, osm_way_id, feature_key):
        return None


class _TileMaterials:
    """タイルごとのフィーチャーの材料と区間の材料（`services/feature_materials.py: FeatureMaterialService`の代役）。"""

    async def materials(self, z, x, y):
        key = WAY if (z, x, y) == WAY_TILE else SEGMENT
        return FeatureMaterials(feature_keys=("other", key),
                                columns={"surface_class": CategoricalColumn.encode(["unpaved", "paved"])})

    async def segments(self, z, x, y):
        return FeatureSegments(feature_keys=("other", WAY, WAY), distance_m=np.array([50.0, 100.0, 300.0]),
                               feature_bearing_deg=np.zeros(3), columns={"gradient_percent": np.array([1.0, 8.0, -4.0])})


class _Gradients:
    """勾配の配信の代役。条件の型は本物のサービスのもの（要求から何を組み立てるかは本物を通す）。"""

    material_id = "gradient_percent"
    conditions_type = GradientConditions

    async def get_way_values(self, z, x, y, conditions):
        return {"other": 9.0, WAY: -1.0} if (z, x, y) == WAY_TILE else {"other": 9.0, SEGMENT: 6.0}

    def segment_values(self, segments, conditions):
        return np.asarray(segments.columns["gradient_percent"], dtype=float)


def _inspector() -> AxisInspectorService:
    return AxisInspectorService(RegionService(repository=_InspectedWayRepository()), _TileMaterials(),
                                {"gradient_percent": _Gradients()}.__getitem__)


QUERY = WayValueQuery(at=None, bearing_deg=0.0, speed_kmh=None)


def _scores(values) -> dict[str, float | None]:
    return {axis.axis_id: axis.difficulty for axis in values.axes}


@pytest.mark.parametrize(("pressed", "feature_key"), [(EDGE_TILE, SEGMENT), (WAY_TILE, WAY)],
                         ids=["区間で塗る倍率", "道1本で塗る倍率"])
async def test_the_inspector_gives_the_values_the_map_paints_for_the_segment_and_for_its_way(pressed, feature_key):
    """押した区間の値は区間で塗る地図の色と、道1本の値は引いた地図の色と同じ値になる（倍率に依らない）。食い違うと、
    同じ道の地図の色と窓の数字が違って見える。道1本で塗る倍率で押したときの区間は、押した地点に最も近いその道の区間。"""
    with replaced_axis_definitions(INSPECTED_AXES):
        result = await _inspector().inspect(int(WAY), feature_key, *pressed, LatLonPoint(35.6, 139.4), QUERY, None)
        painted = {
            tile: {axis_id: await AxisWayValueLens(axis_id, copy_axis_definitions(), _TileMaterials(),
                                                   {"gradient_percent": _Gradients()}.__getitem__).values(*tile, QUERY)
                   for axis_id in INSPECTED_AXES}
            for tile in (EDGE_TILE, WAY_TILE)
        }

    assert _scores(result.segment) == {axis_id: values[SEGMENT] for axis_id, values in painted[EDGE_TILE].items()}
    assert _scores(result.way) == {axis_id: values[WAY] for axis_id, values in painted[WAY_TILE].items()}
    assert _scores(result.way)["axis_grade"] != INSPECTED_AXES["axis_grade"].shape.score_at(-1.0)


async def test_an_axis_whose_conditions_are_missing_has_no_value_and_the_others_combine_without_it():
    """地図の配信なら断る条件の欠け（勾配の走行方位）は、内訳ではその軸だけを「データなし」にし、合成はほかの軸で出す。"""
    with replaced_axis_definitions(INSPECTED_AXES):
        result = await _inspector().inspect(
            int(WAY), SEGMENT, *EDGE_TILE, LatLonPoint(*ON_SEGMENT), WayValueQuery(at=None, bearing_deg=None, speed_kmh=None),
            None)

    assert _scores(result.segment) == {"axis_grade": None, "axis_surface": 10.0}
    assert result.segment.composite_difficulty.value == 10.0


async def test_axis_inspector_combines_with_the_weights_it_is_given():
    """重みを0にした軸は、値があっても合成に効かない（利用者の重みで見せる）。"""
    with replaced_axis_definitions(INSPECTED_AXES):
        weighted, ignored = [
            await _inspector().inspect(int(WAY), SEGMENT, *EDGE_TILE, LatLonPoint(*ON_SEGMENT), QUERY,
                                       RoutePreference(weights={"axis_grade": weight, "axis_surface": 1.0}))
            for weight in (1.0, 0.0)
        ]

    assert next(axis for axis in weighted.segment.axes if axis.axis_id == "axis_grade").contribution not in (None, 0)
    assert not next(axis for axis in ignored.segment.axes if axis.axis_id == "axis_grade").contribution


# --- 事故データ収録年数 ---


class _UnreadableAccidentYearsRepository:
    """収録年を読めないDBの代役。"""

    async def get_accident_years(self):
        raise ConnectionRefusedError("db down")


async def test_accident_years_fall_back_to_empty_on_db_error():
    service = RegionService(repository=_UnreadableAccidentYearsRepository())

    assert await service.get_accident_years() == []
