"""路面タイルと道の名前（`infrastructure/road_tile_sql.py`の`ROAD_SURFACE_TILE_MVT_SQL`・`WAY_NAMES_SQL`。
`infrastructure/road_graph_repository.py: RoadGraphRepository`から流す）が返すもの。道は取込の入口（`tests/source_ingest.py`）から
入れ（タイルを焼く取込範囲と、道の名前の元）、本物のSQLを流す。

確かめるのは、路面タイルが渡したフィーチャーを道ごとの鍵と地図の線の層の値で焼くこと（道ごとの鍵を持つズームと、値の同じ道を
つなぐ引いたズーム）と、地図のレンズのタイルが同じ焼き方で道ごとの材料を数で載せることと、道の名前を道の番号で引くこと。

ここで見ないもの:
- どのフィーチャーを焼くか・押した所に近い道 → `test_map_features.py`
- 材料の式が実在の列だけを読むこと → `test_material_values.py`（全部の読み出しの経路を流す）
- 地図の線の層の値の求め方 → `test_feature_materials.py`
- HTTPの受け渡し・距離の範囲 → `test_region_routes.py`。DB障害の倒し方 → `test_region_service.py`
"""

import mapbox_vector_tile
import pytest
import shapely

from app.domain.region import ROAD_TILE_MIN_ZOOM, tile_bounds_lonlat, tile_position
from app.infrastructure.vector_tile import LENS_LAYER_NAME, ROAD_SURFACE_LAYER_NAME
from tests.source_ingest import WAY_ORIGIN, WAY_STEP, ingest_records, parallel_way_record

pytestmark = pytest.mark.asyncio(loop_scope="module")

#: 道1と道2（東西に引いた、交わらない2本）の間のあたり。
LON = WAY_ORIGIN[0] + WAY_STEP / 2
LAT = WAY_ORIGIN[1] + WAY_STEP * 1.5
#: 道を1本で焼くズーム。
Z = 13


def _line(way_id: int) -> bytes:
    """`parallel_way_record`の道の形（WKB）。"""
    lat = WAY_ORIGIN[1] + WAY_STEP * way_id
    return shapely.to_wkb(shapely.LineString([(WAY_ORIGIN[0], lat), (WAY_ORIGIN[0] + WAY_STEP, lat)]))


async def _ingest_two_ways() -> None:
    await ingest_records("osm_way", [parallel_way_record(1, {"name": "一番通り"}), parallel_way_record(2)])


async def _tile(road_graph_repository, z: int, layer_values: dict[str, dict[str, str | float]],
                layer_name: str = ROAD_SURFACE_LAYER_NAME) -> list[dict]:
    x, y = (int(v) for v in tile_position(LON, LAT, z))
    tile = await road_graph_repository.get_road_feature_tile_mvt(
        layer_name, z, x, y, tile_bounds_lonlat(z, x, y), ["1", "2"], [_line(1), _line(2)], layer_values)
    return [feature["properties"] for feature in mapbox_vector_tile.decode(tile)[layer_name]["features"]]


async def test_the_tile_has_each_roads_layer_values_and_its_key(road_graph_repository):
    """地図は道の線の層と道路タブの段をタイルの値で塗り、道ごとの値（レンズ）を鍵で置く。値の無い道は層の値を持たない。"""
    await _ingest_two_ways()

    tile = await _tile(road_graph_repository, Z, {"1": {"layer_a": "class_a", "layer_b": "-"}})

    assert sorted(tile, key=lambda properties: properties["feature_key"]) == [
        {"feature_key": "1", "layer_a": "class_a", "layer_b": "-"},
        {"feature_key": "2"},
    ]


async def test_the_lens_tile_carries_each_roads_materials_as_numbers(road_graph_repository):
    """地図のレンズは、タイルの材料を地図の式で数として読む（文字で載ると、どの道も値の無い道になる）。材料の無い道は鍵だけを持つ。"""
    await _ingest_two_ways()

    tile = await _tile(road_graph_repository, Z, {"1": {"lens_along": 12.3, "road_bearing_deg": 90.0}}, LENS_LAYER_NAME)

    assert sorted(tile, key=lambda properties: properties["feature_key"]) == [
        {"feature_key": "1", "lens_along": pytest.approx(12.3), "road_bearing_deg": pytest.approx(90.0)},
        {"feature_key": "2"},
    ]


@pytest.mark.parametrize(("way_2_values", "expected"), [
    ({"layer_a": "class_a"}, [{"layer_a": "class_a"}]),
    ({"layer_a": "class_b"}, [{"layer_a": "class_a"}, {"layer_a": "class_b"}]),
], ids=["同じ値", "違う値"])
async def test_below_the_keyed_zoom_roads_with_the_same_values_are_one_feature_without_keys(
    road_graph_repository, way_2_values, expected
):
    """引いた縮尺では道ごとの鍵が要らず、線の数を減らしてタイルを軽くする。"""
    await _ingest_two_ways()

    tile = await _tile(road_graph_repository, ROAD_TILE_MIN_ZOOM - 1, {"1": {"layer_a": "class_a"}, "2": way_2_values})

    assert sorted(tile, key=lambda properties: properties["layer_a"]) == expected


async def test_the_names_of_the_roads_are_read_by_way(road_graph_repository):
    """押した道の小窓は名前を出す。名前の無い道は値を持たず、道の生データに無い道は載らない。"""
    await _ingest_two_ways()

    assert await road_graph_repository.get_way_names([1, 2, 3]) == {1: ("一番通り", None), 2: (None, None)}
