"""地図の路面タイル（DBが焼く形とフィーチャーの鍵。`infrastructure/road_tile_sql.py: ROAD_SURFACE_TILE_MVT_SQL`）の鍵が、道路網の
配列から引くフィーチャーの材料（`domain/road_network.py: tile_feature_materials`）の鍵と噛み合うこと。噛み合わないと、その道は
地図で色が付かない。

道と点は取込の入口から入れ、派生の作り直し（`batch/derive_cli.py: run`）で区間と材料と道路網の配列まで作る（区間と区間の値の行を手で
書くと、2つの読み出しが同じ鍵を作るという前提をテストが書き写すことになる）。

ここで見ないもの:
- 材料ごとの値式が返す値 → `test_material_values.py`
- 鍵ごとの値の集め方と層の値 → `test_feature_materials.py`
"""

import mapbox_vector_tile
import numpy as np
import pytest

from app.batch import derive_cli
from app.domain.region import EDGE_UNIT_MIN_ZOOM, ROAD_TILE_MIN_ZOOM, BoundingBox, tile_bounds_lonlat, tile_position
from app.domain.road_network import tile_feature_materials
from app.infrastructure import road_network_store
from app.infrastructure.vector_tile import ROAD_SURFACE_LAYER_NAME
from tests.conftest import postgis_database_url
from tests.source_ingest import abr_prefecture_record, ingest_records, point_record, way_record

pytestmark = pytest.mark.asyncio(loop_scope="module")

AREA = BoundingBox(min_latitude=35.67, min_longitude=139.69, max_latitude=35.69, max_longitude=139.72)
#: 道1は2区間（ノード2で道2と交わる）、道2は1区間。ノード3は横断歩道。
_WAYS = [
    way_record(1, [(139.700, 35.680), (139.705, 35.6805), (139.6995, 35.681)], [1, 2, 3],
               {"highway": "secondary", "surface": "asphalt"}),
    way_record(2, [(139.705, 35.6805), (139.706, 35.6795)], [2, 4], {"highway": "track"}),
]


async def _derive_world() -> None:
    await ingest_records("osm_way", _WAYS, bbox=AREA)
    await ingest_records("osm_node", [point_record(n, lon, lat, {"highway": "crossing"} if n == 3 else None)
                                      for n, (lon, lat) in ((1, (139.700, 35.680)), (2, (139.705, 35.6805)),
                                                            (3, (139.6995, 35.681)), (4, (139.706, 35.6795)))])
    await ingest_records("abr", [abr_prefecture_record("130001", "東京都", 139.700, 35.680)])
    assert await derive_cli.run(postgis_database_url()) == 0


@pytest.mark.parametrize("z", [EDGE_UNIT_MIN_ZOOM, ROAD_TILE_MIN_ZOOM], ids=["区間で塗るズーム", "道1本で塗るズーム"])
async def test_every_keyed_feature_on_the_map_has_its_materials_in_the_road_network(
        road_graph_repository, road_network_root, z):
    await _derive_world()
    x, y = (int(v) for v in tile_position(139.7025, 35.6805, z))

    tile = await road_graph_repository.get_road_surface_tile_mvt(z, x, y, tile_bounds_lonlat(z, x, y), {})
    keys = {feature["properties"]["feature_key"]
            for feature in mapbox_vector_tile.decode(tile)[ROAD_SURFACE_LAYER_NAME]["features"]}
    materials = tile_feature_materials(road_network_store.current(), z, x, y)

    assert {"1-0", "1-1"} <= keys if z >= EDGE_UNIT_MIN_ZOOM else {"1", "2"} <= keys
    assert keys <= set(materials.feature_keys)
    highway = materials.columns["highway"]
    assert {key: highway.value_at(row) for row, key in enumerate(materials.feature_keys) if key in keys} == {
        key: "track" if key.split("-")[0] == "2" else "secondary" for key in keys}
    crossings = dict(zip(materials.feature_keys, np.asarray(materials.columns["poi_crossing_per_km"]).tolist()))
    assert crossings["1-1" if z >= EDGE_UNIT_MIN_ZOOM else "1"] > 0
