"""`services/region_service.py`——地域のレイヤー（路面・点のタイル）の配信と、区間インスペクタ・事故の収録年。

確かめるのは、焼けなかったタイル（範囲外・DB障害）の空タイルとブラウザに持たせてよいか、焼いたタイルを世代付きの鍵で
ディスクへ残すか、区間インスペクタ（`AxisInspectorService`）が押した区間と道1本の値を地図が塗る値と同じ値で出し、渡された
重みで合成すること、DB障害の倒し方。差し替えるのはDBの口と、インスペクタが読むタイルの材料・材料のサービスと、
失敗の記録（`log_external_call`）だけ。

ここで見ないもの:
- キャッシュの読み書きの骨格 → `test_region_tile_cache.py`
- 世代の文字列の組み立て → `test_cache_identity.py`。世代をTTLで読み直すこと → `test_derived_data_revision_service.py`
- 焼き込むSQLが出す点 → `test_point_tiles.py`
- HTTPの受け渡し → `test_region_routes.py`
- 地図が塗る値の求め方（式の木と道ごとの材料） → `test_dynamic_way_values.py`
"""

import numpy as np
import pytest

from app.config import settings
from app.domain.attributes import CategoricalColumn
from app.domain.axis_definitions import BreakpointLinearShape, CategoricalShape, MaterialTerm
from app.domain.dynamic_way_values import FeatureMaterials, FeatureSegments, WayValueQuery
from app.domain.geo import LatLonPoint
from app.domain.gradient import ROAD_BEARING_LEAF
from app.domain.landcover import LandcoverPercentages
from app.domain.region import EDGE_UNIT_MIN_ZOOM, tile_bounds_lonlat
from app.domain.route_preference import RoutePreference
from app.domain.way_value_formula import way_values_from_formula
from app.infrastructure.derived_data_meta import DataRevisions
from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS
from app.infrastructure.vector_tile import ROAD_SURFACE_LAYER_NAME, encode_empty_tile
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.services.dedicated_way_values import dedicated_way_value_layers
from app.services import region_service
from app.services.region_service import AxisInspectorService, RegionService
from tests.axis_system_fixture import replaced_axis_definitions, shaped_axis
from tests.way_value_lens_fixture import axis_way_value_lens
from tests.fake_external_log import record_external_calls


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
#: 押した地点。
PRESSED = LatLonPoint(35.6, 139.4)
#: 押した道の区間と道1本の土地被覆（別のクラスが全部を占める）。
_LANDCOVER_FIELDS = list(LandcoverPercentages.model_fields)
LANDCOVER = {
    (int(WAY), key): LandcoverPercentages(**{field: 100.0 if field == only else 0.0 for field in _LANDCOVER_FIELDS})
    for key, only in ((SEGMENT, _LANDCOVER_FIELDS[0]), (WAY, _LANDCOVER_FIELDS[1]))
}

#: 道のタグを読む軸と、区間ごとに値の違う材料（勾配）を読む軸。勾配の大きさだけを読む軸は、地図が得点ではなく勾配
#: （符号付き材料）を塗る。タイルの材料を読む軸を先に置く（読めないときに、その後ろの軸の値を落とさないことも見る）。
SIGNED = "axis_slope"
INSPECTED_AXES = {
    "axis_surface": shaped_axis(
        CategoricalShape(material="cat_a", mapping={"paved": 10.0, "unpaved": 90.0}),
        axis_id="axis_surface", is_published=True),
    "axis_grade": shaped_axis(
        BreakpointLinearShape(terms=[MaterialTerm(material="gradient_percent")],
                              breakpoints=[(-10.0, 100.0), (0.0, 0.0), (10.0, 50.0)]),
        axis_id="axis_grade", is_published=True),
    SIGNED: shaped_axis(
        BreakpointLinearShape(terms=[MaterialTerm(material="gradient_percent")], preprocess="abs",
                              breakpoints=[(0.0, 0.0), (10.0, 100.0)]),
        axis_id=SIGNED, is_published=True),
}


class _InspectedWayRepository(RoadGraphRepository):
    """押した道の読み出しだけに答えるなりすまし（実セッションを持たない）。区間を選ぶ空間の照合は実DBで
    `test_feature_materials_in_tile.py`が見る。押した道を押した地点で引いたときだけ区間を返し、土地被覆は押した道の
    区間と道1本で別のものを返す。`unavailable`なら、DB障害として読み出しが失敗する。"""

    def __init__(self, unavailable: bool = False):
        self._unavailable = unavailable

    async def get_way_tags_by_osm_way_id(self, osm_way_id):
        if self._unavailable:
            raise ConnectionRefusedError("db down")
        return ("primary", {})

    async def get_nearest_way_segment(self, osm_way_id, latitude, longitude):
        return (SEGMENT, *ON_SEGMENT) if (osm_way_id, latitude, longitude) == (int(WAY), *PRESSED) else None

    async def get_feature_landcover(self, osm_way_id, feature_key):
        return LANDCOVER.get((osm_way_id, feature_key))


class _TileMaterials:
    """タイルごとのフィーチャーの材料と区間の材料（`services/feature_materials.py: FeatureMaterialService`の代役）。
    `readable`が偽なら、取込範囲外・DB障害のタイルとしてどちらも読めない。"""

    def __init__(self, readable: bool = True):
        self._readable = readable

    async def materials(self, z, x, y):
        key = WAY if (z, x, y) == WAY_TILE else SEGMENT
        return FeatureMaterials(feature_keys=("other", key),
                                columns={"cat_a": CategoricalColumn.encode(["unpaved", "paved"])}
                                ) if self._readable else None

    async def segments(self, z, x, y):
        return FeatureSegments(feature_keys=("other", WAY, WAY), distance_m=np.array([50.0, 100.0, 300.0]),
                               feature_bearing_deg=np.zeros(3), columns={"gradient_percent": np.array([1.0, 8.0, -4.0])}
                               ) if self._readable else None


#: 押した道は、走行方位（`QUERY`の北）と逆向きの道。ほかは走行方位に沿う。
ROAD_BEARINGS = {WAY: 180.0}


class _Gradients:
    """勾配の配信の代役。配る材料の木と受け取る条件の型は、登録された本物のサービスのものが使われる。区間の向きは、
    区間が属する道の向き。"""

    async def get_way_materials(self, z, x, y, at):
        gradients = {"other": 9.0, WAY: 1.0} if (z, x, y) == WAY_TILE else {"other": 9.0, SEGMENT: 6.0}
        return {"gradient_percent": gradients, ROAD_BEARING_LEAF: {key: ROAD_BEARINGS.get(key, 0.0) for key in gradients}}

    def segment_materials(self, segments):
        return {"gradient_percent": np.asarray(segments.columns["gradient_percent"], dtype=float),
                ROAD_BEARING_LEAF: np.array([ROAD_BEARINGS.get(key, 0.0) for key in segments.feature_keys])}


def _inspector(readable: bool = True, unavailable: bool = False) -> AxisInspectorService:
    return AxisInspectorService(RegionService(repository=_InspectedWayRepository(unavailable)), _TileMaterials(readable),
                                {"gradient_percent": _Gradients()}.__getitem__)


QUERY = WayValueQuery(at=None, bearing_deg=0.0, speed_kmh=None)


def _scores(values) -> dict[str, float | None]:
    return {axis.axis_id: axis.difficulty for axis in values.axes}


def _difficulty(axis_id: str, painted: float) -> float:
    """地図が塗る値の得点。勾配を塗る軸は、塗った勾配の大きさの得点（地図の色の段と同じ段）。"""
    return INSPECTED_AXES[SIGNED].shape.score_at(abs(painted)) if axis_id == SIGNED else painted


async def _map_values(axis_id: str, tile: tuple[int, int, int]) -> dict[str, float | None]:
    """地図が塗る値: 軸カタログの式の木へ、地図が受け取る道ごとの材料と`QUERY`の走る向きを入れたもの。"""
    lens = axis_way_value_lens(axis_id, _TileMaterials(), {"gradient_percent": _Gradients()})
    by_way = await lens.way_materials(*tile, QUERY)
    formula = dedicated_way_value_layers()[axis_id].formula
    assert isinstance(by_way, dict) and formula is not None
    keys = list(by_way)
    names = {name for materials in by_way.values() for name in materials}
    leaves = {name: [by_way[key].get(name, np.nan) for key in keys] for name in names}
    return way_values_from_formula(formula, keys, leaves, {"bearing_deg": QUERY.bearing_deg})


@pytest.mark.parametrize(("pressed", "feature_key"), [(EDGE_TILE, SEGMENT), (WAY_TILE, WAY)],
                         ids=["区間で塗る倍率", "道1本で塗る倍率"])
async def test_the_inspector_gives_the_values_the_map_paints_for_the_segment_and_for_its_way(pressed, feature_key):
    """押した区間の値は区間で塗る地図の色と、道1本の値は引いた地図の色と同じ値になる（倍率に依らない）。食い違うと、
    同じ道の地図の色と窓の数字が違って見える。勾配を塗る軸も、窓には得点を出す。道1本で塗る倍率で押したときの区間は、
    押した地点に最も近いその道の区間。道1本の値は、その道の区間を走った向きの勾配の得点の距離平均（ルートの値と同じ）で、
    道のタグも読む軸も区間から畳む。土地被覆は、区間と道1本でそれぞれのもの。内部軸は地図が塗らないので、窓にも出ない。"""
    axes = {**INSPECTED_AXES, "axis_mixed": shaped_axis(
        BreakpointLinearShape(terms=[MaterialTerm(material="axis_surface"), MaterialTerm(material="axis_grade")],
                              breakpoints=[(0.0, 0.0), (200.0, 100.0)]),
        axis_id="axis_mixed", is_published=True)}
    internal = shaped_axis(BreakpointLinearShape(terms=[MaterialTerm(material="gradient_percent")],
                                                 breakpoints=[(0.0, 0.0), (10.0, 100.0)]), axis_id="axis_internal")
    with replaced_axis_definitions({**axes, internal.axis_id: internal}):
        result = await _inspector().inspect(int(WAY), feature_key, *pressed, PRESSED, QUERY, None)
        painted = {tile: {axis_id: await _map_values(axis_id, tile) for axis_id in axes} for tile in (EDGE_TILE, WAY_TILE)}

    assert _scores(result.segment) == {
        axis_id: _difficulty(axis_id, values[SEGMENT]) for axis_id, values in painted[EDGE_TILE].items()}
    assert _scores(result.way) == {
        axis_id: _difficulty(axis_id, values[WAY]) for axis_id, values in painted[WAY_TILE].items()}
    grade = INSPECTED_AXES["axis_grade"].shape
    assert _scores(result.way)["axis_grade"] == (grade.score_at(-8.0) * 100 + grade.score_at(4.0) * 300) / 400
    assert (result.segment.landcover, result.way.landcover) == (LANDCOVER[(int(WAY), SEGMENT)], LANDCOVER[(int(WAY), WAY)])


@pytest.mark.parametrize(("readable", "pressed", "feature_key", "segment", "way"), [
    (False, WAY_TILE, WAY, {"axis_surface": None, "axis_grade": 30.0, SIGNED: 60.0},
     dict.fromkeys(INSPECTED_AXES)),
    (True, EDGE_TILE, f"{WAY}-9", dict.fromkeys(INSPECTED_AXES), {"axis_surface": 10.0, "axis_grade": 35.0, SIGNED: 50.0}),
], ids=["タイルの材料を読めない", "押した区間がタイルに無い"])
async def test_what_the_map_does_not_paint_is_no_data_in_the_inspector(readable, pressed, feature_key, segment, way):
    """取込範囲外・DB障害でタイルの材料を読めない軸と、押した区間を今のタイルが持たない（地図のタイルが前の世代）ときは、
    窓はその軸を「データなし」にし、ほかの値は出す。失敗すると、道を押しても窓が開かない。"""
    with replaced_axis_definitions(INSPECTED_AXES):
        result = await _inspector(readable).inspect(int(WAY), feature_key, *pressed, PRESSED, QUERY, None)

    assert (_scores(result.segment), _scores(result.way)) == (segment, way)


async def test_an_axis_whose_conditions_are_missing_has_no_value_and_the_others_combine_without_it():
    """条件の欠け（勾配の走行方位）は、内訳ではその軸だけを「データなし」にし、合成はほかの軸で出す。"""
    with replaced_axis_definitions(INSPECTED_AXES):
        result = await _inspector().inspect(
            int(WAY), SEGMENT, *EDGE_TILE, PRESSED, WayValueQuery(at=None, bearing_deg=None, speed_kmh=None),
            None)

    assert _scores(result.segment) == {"axis_surface": 10.0, "axis_grade": None, SIGNED: None}
    assert result.segment.composite_difficulty.value == 10.0


async def test_axis_inspector_combines_with_the_weights_it_is_given():
    """重みを0にした軸は、値があっても合成に効かない（利用者の重みで見せる）。"""
    with replaced_axis_definitions(INSPECTED_AXES):
        weighted, ignored = [
            await _inspector().inspect(int(WAY), SEGMENT, *EDGE_TILE, PRESSED, QUERY,
                                       RoutePreference(weights={"axis_grade": weight, "axis_surface": 1.0}))
            for weight in (1.0, 0.0)
        ]

    assert next(axis for axis in weighted.segment.axes if axis.axis_id == "axis_grade").contribution not in (None, 0)
    assert not next(axis for axis in ignored.segment.axes if axis.axis_id == "axis_grade").contribution


async def test_the_inspector_does_not_open_and_is_counted_as_a_failure_when_the_db_is_down(monkeypatch):
    """DB障害では窓は開かず（応答はNone）、失敗が`/api/debug/stats`の集計に載る。"""
    calls = record_external_calls(monkeypatch, region_service)

    result = await _inspector(unavailable=True).inspect(int(WAY), WAY, *WAY_TILE, PRESSED, QUERY, None)

    assert result is None
    assert [(call.fields["result"], call.fields["error_type"]) for call in calls] == [("error", "ConnectionRefusedError")]


# --- 事故データ収録年数 ---


class _UnreadableAccidentYearsRepository:
    """収録年を読めないDBの代役。"""

    async def get_accident_years(self):
        raise ConnectionRefusedError("db down")


async def test_accident_years_fall_back_to_empty_on_db_error():
    service = RegionService(repository=_UnreadableAccidentYearsRepository())

    assert await service.get_accident_years() == []
