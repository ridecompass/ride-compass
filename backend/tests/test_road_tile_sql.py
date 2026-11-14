"""路面タイルと押した所に近い道（`infrastructure/road_tile_sql.py`の`ROAD_SURFACE_TILE_MVT_SQL`・`ROADS_AT_SQL`。
`infrastructure/road_graph_repository.py: RoadGraphRepository`から流す）が返すもの。道は取込の入口（`tests/source_ingest.py`）から
入れ、本物のSQLを流す。

確かめるのは、路面タイルが道ごとに地図の線の層の値を持つこと（道ごとの鍵を持つズームと、値の同じ道をつなぐ引いたズーム）、
拾う距離の中の道を近い順に返すこと、距離の外の道と数の上限を超える道を返さないこと、押した道がタイルのフィーチャーと同じ鍵を
持つこと、形がタイルで切らない線の全体であること。

ここで見ないもの:
- 材料の式が実在の列だけを読むこと → `test_material_values.py`（全部の読み出しの経路を流す）
- 地図の線の層の値の求め方 → `test_feature_materials.py`
- HTTPの受け渡し・距離の範囲 → `test_region_routes.py`。DB障害の倒し方 → `test_region_service.py`
"""

import mapbox_vector_tile
import pytest

from app.domain.region import ROAD_TILE_MIN_ZOOM, tile_bounds_lonlat, tile_position
from app.infrastructure.vector_tile import ROAD_SURFACE_LAYER_NAME
from tests.source_ingest import WAY_ORIGIN, WAY_STEP, ingest_records, parallel_way_record

pytestmark = pytest.mark.asyncio(loop_scope="module")

#: 道1（北へ`WAY_STEP`）と道2（北へ2倍）を東西に引いた所の、道1の中ほどのやや北。道1まで約22m、道2まで約89m。
LON = WAY_ORIGIN[0] + WAY_STEP / 2
LAT = WAY_ORIGIN[1] + WAY_STEP * 1.2
#: 道を1本で焼くズーム。
Z = 13


async def _ingest_two_ways() -> None:
    await ingest_records("osm_way", [parallel_way_record(1, {"name": "一番通り"}), parallel_way_record(2)])


async def test_the_roads_within_reach_come_nearest_first(road_graph_repository):
    await _ingest_two_ways()

    within_both = await road_graph_repository.roads_at(LON, LAT, Z, 100.0, 3)
    within_one = await road_graph_repository.roads_at(LON, LAT, Z, 50.0, 3)
    first_only = await road_graph_repository.roads_at(LON, LAT, Z, 100.0, 1)

    def ways(roads):
        return [road.properties["osm_way_id"] for road in roads]

    assert [ways(within_both), ways(within_one), ways(first_only)] == [[1, 2], [1], [1]]


def _tile_properties(tile: bytes) -> list[dict]:
    return [feature["properties"] for feature in mapbox_vector_tile.decode(tile)[ROAD_SURFACE_LAYER_NAME]["features"]]


async def _tile(road_graph_repository, z: int, layer_values: dict[str, dict[str, str]]) -> list[dict]:
    x, y = (int(v) for v in tile_position(LON, LAT, z))
    return _tile_properties(
        await road_graph_repository.get_road_surface_tile_mvt(z, x, y, tile_bounds_lonlat(z, x, y), layer_values))


async def test_a_road_has_the_key_of_its_tile_feature_and_its_whole_line(road_graph_repository):
    """押して開く小窓は、押した道の地図の線の層の値を、同じ鍵のタイルのフィーチャーから読む。"""
    await _ingest_two_ways()

    [road, _] = await road_graph_repository.roads_at(LON, LAT, Z, 100.0, 3)
    keys = [properties["feature_key"] for properties in await _tile(road_graph_repository, Z, {})]

    assert road.properties["feature_key"] == "1"
    assert sorted(keys) == ["1", "2"]
    assert road.shape == [(WAY_ORIGIN[0], LAT - WAY_STEP * 0.2), (WAY_ORIGIN[0] + WAY_STEP, LAT - WAY_STEP * 0.2)]


async def test_the_tile_has_each_roads_layer_values_and_its_key(road_graph_repository):
    """地図は道の線の層と道路タブの段をタイルの値で塗り、道ごとの値（レンズ）を鍵で置く。値の無い道は層の値を持たない。"""
    await _ingest_two_ways()

    tile = await _tile(road_graph_repository, Z, {"1": {"layer_a": "class_a", "layer_b": "-"}})

    assert sorted(tile, key=lambda properties: properties["feature_key"]) == [
        {"feature_key": "1", "layer_a": "class_a", "layer_b": "-"},
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
