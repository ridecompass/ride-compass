"""押した所に近い道（`infrastructure/road_graph_repository.py: RoadGraphRepository.roads_at`。SQLは
`road_tile_sql.py: ROADS_AT_SQL`）が返すもの。道は取込の入口（`tests/source_ingest.py`）から入れ、本物のSQLを流す。

確かめるのは、拾う距離の中の道を近い順に返すこと、距離の外の道と数の上限を超える道を返さないこと、プロパティが同じズームの
路面タイルのフィーチャーと同じであること、形がタイルで切らない線の全体であること。

ここで見ないもの:
- 材料の式が実在の列だけを読むこと → `test_material_values.py`（全部の読み出しの経路を流す）
- HTTPの受け渡し・距離の範囲 → `test_region_routes.py`。DB障害の倒し方 → `test_region_service.py`
"""

import mapbox_vector_tile
import pytest

from app.domain.region import tile_bounds_lonlat, tile_position
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


async def test_a_road_has_the_properties_its_tile_feature_has_and_its_whole_line(road_graph_repository):
    """押して開く小窓と地図の線が、同じ鍵・同じ値を読む。タイルは値の無い列を省くので、口も省く。"""
    await _ingest_two_ways()
    x, y = (int(v) for v in tile_position(LON, LAT, Z))

    [road, _] = await road_graph_repository.roads_at(LON, LAT, Z, 100.0, 3)
    tile = await road_graph_repository.get_road_surface_tile_mvt(Z, x, y, tile_bounds_lonlat(Z, x, y))
    features = mapbox_vector_tile.decode(tile)[ROAD_SURFACE_LAYER_NAME]["features"]
    [baked] = [feature["properties"] for feature in features if feature["properties"]["osm_way_id"] == 1]

    assert road.properties == baked
    assert road.shape == [(WAY_ORIGIN[0], LAT - WAY_STEP * 0.2), (WAY_ORIGIN[0] + WAY_STEP, LAT - WAY_STEP * 0.2)]
