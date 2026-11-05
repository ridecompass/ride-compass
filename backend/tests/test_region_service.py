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
from app.domain.cost_preference import CostPreference
from app.infrastructure.derived_data_meta import DataRevisions
from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS
from app.infrastructure.vector_tile import ROAD_SURFACE_LAYER_NAME, encode_empty_tile
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.services import region_service
from app.services.region_service import RegionService, RoadInspectorService
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


# --- 道の窓 ---


class _UnreachableWayRepository(RoadGraphRepository):
    """押した道の読み出しがDB障害で失敗するなりすまし（実セッションを持たない）。"""

    def __init__(self):
        pass

    async def get_way_tags_by_osm_way_id(self, osm_way_id):
        raise ConnectionRefusedError("db down")


class _UnusedLens:
    """道が見つからなければ、レンズの値は求めない。"""

    async def inspect(self, *args):
        raise AssertionError("道の見つからない窓のレンズを求めた")


async def test_the_inspector_does_not_open_and_is_counted_as_a_failure_when_the_db_is_down(monkeypatch):
    """DB障害では窓は開かず（応答はNone）、失敗が`/api/debug/stats`の集計に載る。"""
    calls = record_external_calls(monkeypatch, region_service)

    inspector = RoadInspectorService(RegionService(repository=_UnreachableWayRepository()), _UnusedLens())
    result = await inspector.inspect(123, "123", (14, 1, 2), 0.0, None, 20.0, CostPreference())

    assert result is None
    assert [(call.fields["result"], call.fields["error_type"]) for call in calls] == [("error", "ConnectionRefusedError")]


class _UnreachableRoadsRepository:
    """近い道を読めないDBの代役。"""

    async def roads_at(self, lon, lat, z, radius_m, limit):
        raise ConnectionRefusedError("db down")


async def test_no_road_is_found_and_it_is_counted_as_a_failure_when_the_db_is_down(monkeypatch):
    """DB障害では道が無い所を押したのと同じに小窓を開かず、失敗が`/api/debug/stats`の集計に載る。"""
    calls = record_external_calls(monkeypatch, region_service)

    roads = await RegionService(repository=_UnreachableRoadsRepository()).roads_at(139.70, 35.68, 14, 30.0)

    assert roads == []
    assert [(call.fields["result"], call.fields["error_type"]) for call in calls] == [("error", "ConnectionRefusedError")]


# --- 事故データ収録年数 ---


class _UnreadableAccidentYearsRepository:
    """収録年を読めないDBの代役。"""

    async def get_accident_years(self):
        raise ConnectionRefusedError("db down")


async def test_accident_years_fall_back_to_empty_on_db_error():
    service = RegionService(repository=_UnreadableAccidentYearsRepository())

    assert await service.get_accident_years() == []
