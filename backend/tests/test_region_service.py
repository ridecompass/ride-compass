"""`services/region_service.py`——地域のレイヤー（路面・点のタイル）の配信と、道の窓・押した所に近い道・事故の収録年。

確かめるのは、焼けなかったタイル（範囲外・DB障害）の空タイルとブラウザに持たせてよいか、焼いたタイルを世代付きの鍵で
ディスクへ残すか、DB障害の倒し方。差し替えるのはDBの口と、失敗の記録（`log_external_call`）だけ。

ここで見ないもの:
- キャッシュの読み書きの骨格 → `test_region_tile_cache.py`
- 世代の文字列の組み立て → `test_cache_identity.py`。世代をTTLで読み直すこと → `test_derived_data_revision_service.py`
- 焼き込むSQLが出す点 → `test_point_tiles.py`
- HTTPの受け渡し → `test_region_routes.py`
- 道の窓のレンズの値（地図のレンズと同じ値） → `test_region_lens.py`
"""

import pytest

from app.config import settings
from app.infrastructure.derived_data_meta import DataRevisions
from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS
from app.infrastructure.vector_tile import ROAD_SURFACE_LAYER_NAME, encode_empty_tile
from app.services.region_service import RegionService


Z, X, Y = 14, 14551, 6447
POINT_LAYER = next(iter(POINT_TILE_LAYERS.values()))


class _TileRepository:
    """路面・点のMVTを焼く口とデータの世代だけを持つフェイク。取込範囲外はNone。"""

    def __init__(self, tile: bytes | None = None, derived: int | None = 1):
        self.tile = tile
        self.derived = derived

    async def get_data_revisions(self):
        return DataRevisions(derived=self.derived, imported=1)

    async def get_road_surface_tile_mvt(self, z, x, y, bbox):
        return self.tile

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

    assert tile == (b"first" if kept else b"second")


# --- 道の窓 ---


class _UnusedLens:
    """道が見つからなければ、レンズの値は求めない。"""

    async def inspect(self, *args):
        raise AssertionError("道の見つからない窓のレンズを求めた")

# --- 事故データ収録年数 ---


