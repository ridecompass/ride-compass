"""`services/region_service.py`——地域のレイヤー（路面・点のタイル）の配信と、道の窓・押した所に近い道・事故の収録年。

確かめるのは、焼けなかったタイル（範囲外）の空タイル、焼いたタイルを捨てるまでディスクから配るか。差し替えるのはDBの口だけで、
路面タイルが焼く地図の線の層の値の元の道路網は、本番と同じ置き場から読ませる（`tests/route_world.py: serve_road_network`）。

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
from app.domain.region import ROAD_TILE_MIN_ZOOM
from app.domain.time_frames import StaleTimeFrameError
from app.services.time_frame_service import TimeFrameService, new_frame_cache
from tests.route_world import Weather, grid_network, serve_road_network


Z, X, Y = 14, 14551, 6447
POINT_LAYER = next(iter(POINT_TILE_LAYERS.values()))


class _TileRepository:
    """路面・点のMVTを焼く口だけを持つフェイク。取込範囲外はNone。"""

    def __init__(self, tile: bytes | None = None):
        self.tile = tile

    async def get_road_surface_tile_mvt(self, z, x, y, bbox, feature_keys, shapes, layer_values):
        return self.tile

    async def get_tile_mvt(self, sql, layer_name, z, x, y, bbox):
        return self.tile


def _road_surface_tile(service, frame=None):
    return service.get_road_surface_tile(Z, X, Y, frame, TimeFrameService(Weather(), new_frame_cache()))


def _point_tile(service):
    return service.get_point_tile(POINT_LAYER, Z, X, Y)


@pytest.mark.parametrize(("serve", "empty_tile"), [
    (_road_surface_tile, encode_empty_tile(ROAD_SURFACE_LAYER_NAME)),
    # 点のレイヤーも同じ道で配る。空タイルは自分のsource-layerを名乗る。
    (_point_tile, encode_empty_tile(POINT_LAYER.source_layer)),
], ids=["範囲外", "点のレイヤー"])
async def test_a_tile_outside_the_coverage_is_the_empty_tile_of_its_layer(serve, empty_tile, road_network_root):
    serve_road_network(road_network_root, grid_network())
    service = RegionService(repository=_TileRepository(tile=None))

    assert await serve(service) == empty_tile


async def test_a_baked_tile_is_served_from_disk_until_the_region_tiles_are_discarded(road_network_root):
    """焼いたタイルはDBが変わってもディスクから配り続け、作り直しの終わりに捨てると焼き直す。"""
    serve_road_network(road_network_root, grid_network())
    repository = _TileRepository(tile=b"first")
    service = RegionService(repository=repository)
    await _road_surface_tile(service)

    repository.tile = b"second"
    kept = await _road_surface_tile(service)
    discard_region_tiles()

    assert (kept, await _road_surface_tile(service)) == (b"first", b"second")


async def test_a_tile_of_a_frame_outside_the_current_frames_is_refused(road_network_root):
    """終わったコマ・作り直す前の道路網のコマの印では焼かない（前の効き方で焼いたタイルを今のものとして配らない）。時刻を読まない
    引いたズームのタイルは印を確かめず、時刻で変わらない規制だけで焼く（古い印でも道の線を消さない）。"""
    serve_road_network(road_network_root, grid_network())
    service = RegionService(repository=_TileRepository(tile=b"tile"))
    time_frames = TimeFrameService(Weather(), new_frame_cache())

    def tile(z: int) -> tuple[int, int, int]:
        return z, X >> (Z - z), Y >> (Z - z)

    with pytest.raises(StaleTimeFrameError):
        await service.get_road_surface_tile(*tile(ROAD_TILE_MIN_ZOOM), "0-unknown", time_frames)
    assert await service.get_road_surface_tile(*tile(ROAD_TILE_MIN_ZOOM - 1), "0-unknown", time_frames) == b"tile"


# --- 道の窓 ---


class _UnusedLens:
    """道が見つからなければ、レンズの値は求めない。"""

    async def inspect(self, *args):
        raise AssertionError("道の見つからない窓のレンズを求めた")

# --- 事故データ収録年数 ---


