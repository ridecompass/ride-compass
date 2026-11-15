"""`services/region_service.py`——地域のレイヤー（路面・点のタイル）の配信と、道の窓・押した所に近い道・事故の収録年。

確かめるのは、焼けなかったタイル（範囲外）の空タイル、焼いたタイルを捨てるまでディスクから配るか。差し替えるのはDBの口だけ。

ここで見ないもの:
- キャッシュの読み書きの骨格 → `test_region_tile_cache.py`
- 作り直し・区分の書き換えが捨てること → `test_derive_cli.py`・`test_road_class_admin_routes.py`
- 焼き込むSQLが出す点 → `test_point_tiles.py`
- HTTPの受け渡し → `test_region_routes.py`
- 道の窓のレンズの値（地図のレンズと同じ値） → `test_region_lens.py`
"""

import pytest

from app.infrastructure.region_tile_cache import discard_region_tiles
from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS
from app.infrastructure.vector_tile import ROAD_SURFACE_LAYER_NAME, encode_empty_tile
from app.services.region_service import RegionService


Z, X, Y = 14, 14551, 6447
POINT_LAYER = next(iter(POINT_TILE_LAYERS.values()))


class _TileRepository:
    """路面・点のMVTを焼く口だけを持つフェイク。取込範囲外はNone。路面タイルが焼く地図の線の層の値の元
    （タイルの材料）は無い（範囲外）。"""

    def __init__(self, tile: bytes | None = None):
        self.tile = tile

    async def get_road_surface_tile_mvt(self, z, x, y, bbox, layer_values):
        return self.tile

    async def get_accident_years_covered(self):
        return 1

    async def get_feature_materials_in_tile(self, z, x, y, bbox, accident_years_covered):
        return None

    async def get_tile_mvt(self, sql, layer_name, z, x, y, bbox):
        return self.tile


def _road_surface_tile(service):
    return service.get_road_surface_tile(Z, X, Y)


def _point_tile(service):
    return service.get_point_tile(POINT_LAYER, Z, X, Y)


@pytest.mark.parametrize(("serve", "empty_tile"), [
    (_road_surface_tile, encode_empty_tile(ROAD_SURFACE_LAYER_NAME)),
    # 点のレイヤーも同じ道で配る。空タイルは自分のsource-layerを名乗る。
    (_point_tile, encode_empty_tile(POINT_LAYER.source_layer)),
], ids=["範囲外", "点のレイヤー"])
async def test_a_tile_outside_the_coverage_is_the_empty_tile_of_its_layer(serve, empty_tile):
    service = RegionService(repository=_TileRepository(tile=None))

    assert await serve(service) == empty_tile


async def test_a_baked_tile_is_served_from_disk_until_the_region_tiles_are_discarded():
    """焼いたタイルはDBが変わってもディスクから配り続け、作り直しの終わりに捨てると焼き直す。"""
    repository = _TileRepository(tile=b"first")
    service = RegionService(repository=repository)
    await _road_surface_tile(service)

    repository.tile = b"second"
    kept = await _road_surface_tile(service)
    discard_region_tiles()

    assert (kept, await _road_surface_tile(service)) == (b"first", b"second")


# --- 道の窓 ---


class _UnusedLens:
    """道が見つからなければ、レンズの値は求めない。"""

    async def inspect(self, *args):
        raise AssertionError("道の見つからない窓のレンズを求めた")

# --- 事故データ収録年数 ---


