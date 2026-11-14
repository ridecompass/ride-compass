from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from functools import partial

from app.domain.cost_preference import CostPreference
from app.domain.lens_values import RoadInspection
from app.domain.region import ROADS_AT_LIMIT, BoundingBox, RoadAt, tile_bounds_lonlat
from app.domain.registry import TileKind
from app.domain.road_classes import current_road_classes
from app.domain.tuning import REBUILT_CLIENT_TUNING_IDS
from app.infrastructure.debug_log import log_external_call, log_throttled_warning
from app.infrastructure.point_tile_layers import PointTileLayer
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.infrastructure.vector_tile import ROAD_SURFACE_LAYER_NAME, encode_empty_tile
from app.infrastructure.media_types import MVT_CONTENT_TYPE
from app.infrastructure.region_tile_cache import serve_region_tile
from app.services.feature_materials import FeatureMaterialService
from app.services.lens_service import LensService
from app.services.tile_version_service import (
    current_tile_versions,
    prune_other_tile_generations,
    road_surface_tile_shape,
    served_tile_version,
)

# z・x・yとその範囲（経度・緯度）から、PostGISが生成したタイル1枚を返す読み出し。
_TileReader = Callable[[int, int, int, BoundingBox], Awaitable[bytes | None]]


@dataclass(frozen=True)
class _InspectedRoad:
    highway: str
    tags: dict[str, str]


class RegionService:
    """候補ルートに紐づかない「地域全体」のレイヤーを、XYZベクタタイルとして配る。

    生成したタイルは基礎地図タイルと同じファイルキャッシュへ置く。そのため管理画面からの
    一括クリア（`api/routers/basemap.py: basemap_refresh`）で両方とも消える。

    カバレッジ外は空タイルを返し、DB障害は投げる（503）。取れなかったときに別の経路から取り直すフォールバックは持たない。
    """

    def __init__(self, repository: RoadGraphRepository):
        self._repository = repository

    async def tile_versions(self) -> dict[TileKind, str]:
        """系統名→配信する世代（`services/tile_version_service.py`）。

        DBの口（`repository`）を外へ出さずにここで閉じる。**外へ出すと、呼び出し側が
        どのセッション設定（タイムアウト）の上で動いているのかが見えないまま
        infrastructureを直接触ることになる**——このサービスを作る依存
        （`api/dependencies.py: get_region_service`）と、repositoryを直接配る依存とでは
        タイムアウトが違う。
        """
        return await current_tile_versions(self._repository)

    async def prune_other_tile_generations(self) -> int:
        """いま配っていない世代の地域タイル（路面・点・土地被覆）をディスクから消し、消した数を返す
        （`services/tile_version_service.py`）。"""
        return await prune_other_tile_generations(self._repository)

    async def _get_tile(
        self,
        *,
        read_tile: _TileReader,
        kind: TileKind,
        shape: str,
        empty_tile: bytes,
        external_call_name: str,
        z: int, x: int, y: int,
    ) -> bytes:
        async def fetch_tile(fields: dict) -> bytes | None:
            """PostGIS側（ST_AsMVT）でタイル1枚分のMVTを丸ごと生成する。

            `read_tile`は「カバレッジ外はNone・カバレッジ内0件は空バイト列」という契約を
            満たすこと。DB障害は投げる。
            """
            # カバレッジ判定（取込の宣言した範囲か）はMVT生成と同じ1クエリへ畳み込まれて
            # いる（DBの往復1回分を節約。repository側のdocstring参照）。
            tile_bytes = await read_tile(z, x, y, tile_bounds_lonlat(z, x, y))
            if tile_bytes is None:
                # 取込範囲外は取得できないのが正常な場合で、WARNINGにしない（地図を範囲の外へ動かすたびに出る）。
                fields["postgis"] = "uncovered"
                return None
            fields["postgis"] = "hit"
            return tile_bytes

        return await serve_region_tile(
            kind=kind,
            generation=await served_tile_version(self._repository, shape),
            z=z, x=x, y=y,
            extension="pbf",
            empty_tile=empty_tile,
            content_type=MVT_CONTENT_TYPE,
            external_call_name=external_call_name,
            fetch_tile=fetch_tile,
        )

    async def get_road_surface_tile(self, z: int, x: int, y: int) -> bytes:
        """地図の道の線のタイル。地図の線の層の値（`services/feature_materials.py: FeatureMaterialService.road_layer_values`）を
        焼く。世代と焼く値は同じ区分の全体から求める（間に区分を書き換えられても、古い世代の鍵へ新しい値を残さない）。"""
        materials = FeatureMaterialService(self._repository)
        definitions = current_road_classes()

        async def read_tile(z: int, x: int, y: int, bbox: BoundingBox) -> bytes | None:
            layer_values = await materials.road_layer_values(z, x, y, definitions)
            return await self._repository.get_road_surface_tile_mvt(z, x, y, bbox, layer_values)

        return await self._get_tile(
            read_tile=read_tile,
            kind="road_surface",
            shape=road_surface_tile_shape(definitions),
            empty_tile=encode_empty_tile(ROAD_SURFACE_LAYER_NAME),
            external_call_name="region:road-surface-tile",
            z=z, x=x, y=y,
        )

    async def get_point_tile(self, layer: PointTileLayer, z: int, x: int, y: int) -> bytes:
        """点のレイヤー（`infrastructure/point_tile_layers.py`）のタイル。どのレイヤーも同じ道で配る。"""
        return await self._get_tile(
            read_tile=partial(self._repository.get_tile_mvt, layer.sql, layer.source_layer),
            kind=layer.name,
            shape=layer.shape,
            empty_tile=encode_empty_tile(layer.source_layer),
            external_call_name=f"region:{layer.name}-tile",
            z=z, x=x, y=y,
        )

    async def inspected_road(self, osm_way_id: int) -> _InspectedRoad | None:
        """道の窓が出す、押した道の一次属性。

        引き直しの鍵はタイルへ焼き込み済みのosm_way_idで、クリック地点の緯度経度から道を空間マッチで選ばない——交差点
        付近など複数の道路が近接する場所で、実際にクリックされたフィーチャーとは別の道路を拾う。

        該当wayが無ければNone。DB障害は投げる。
        """
        with log_external_call("region:road-inspector", osm_way_id=osm_way_id) as fields:
            way_tags_result = await self._repository.get_way_tags_by_osm_way_id(osm_way_id)
            if way_tags_result is None:
                fields["lookup"] = "not_found"
                return None
            fields["lookup"] = "ok"
            highway, tags = way_tags_result
            return _InspectedRoad(highway, tags)

    async def roads_at(self, lon: float, lat: float, z: int, radius_m: float) -> list[RoadAt]:
        """押した所に近い道（近い順、最大`ROADS_AT_LIMIT`本）。道のタイルを読まずに道を押せるようにする。"""
        with log_external_call("region:roads-at", z=z) as fields:
            roads = await self._repository.roads_at(lon, lat, z, radius_m, ROADS_AT_LIMIT)
            fields["found"] = len(roads)
            return roads

    async def get_accident_years(self) -> list[int]:
        """事故データの収録年。地図の説明文へ配る。

        表示側が年を文字列で持つと、取り込み直したときに黙って食い違う。年の正本は
        今の事故の数を数えた取込の宣言（`source_runs.profile`）だけにする。
        """
        with log_external_call("region:accident-years-covered") as fields:
            years = await self._repository.get_accident_years()
            fields["years_covered"] = len(years)
            return years

    async def get_rebuilt_client_tuning(self) -> dict[str, float]:
        """フロントへ配る較正値のうち作り直しで効くもの（`REBUILT_CLIENT_TUNING_IDS`）の、作り直しに使った値。"""
        with log_external_call("region:rebuilt-client-tuning"):
            return await self._repository.get_recorded_tuning(REBUILT_CLIENT_TUNING_IDS)

    async def get_ingested_area(self) -> BoundingBox | None:
        """サービスの対象範囲（取り込んだ道路の範囲）。気象庁タイルのプリウォームが、ここから
        範囲を引く——範囲を持つのは取込の宣言だけで、取込範囲を広げればタイルも同じ範囲へ広がる。

        道路をまだ取り込んでいないときはNone（WARNING）。
        """
        with log_external_call("region:ingested-area") as fields:
            area = await self._repository.get_ingested_area()
            fields["ingested"] = area is not None
            if area is None:
                log_throttled_warning("region:ingested-area", "道路の取込が成功した記録が無く、対象範囲が決まらない")
            return area


class RoadInspectorService:
    """道の窓。押した道の一次属性と、押したフィーチャーのレンズの値を、地図のレンズと同じ口
    （`services/lens_service.py: LensService.inspect`）から出す——地図の色と道の窓の数字が同じ値になる。"""

    def __init__(self, region_service: RegionService, lens: LensService):
        self._region_service = region_service
        self._lens = lens

    async def inspect(
        self, osm_way_id: int, feature_key: str, tile: tuple[int, int, int], bearing_deg: float, at: datetime | None,
        speed_kmh: float, cost_preference: CostPreference,
    ) -> RoadInspection | None:
        """押した道（osm_way_id）か、タイル`tile`（押したフィーチャー`feature_key`を焼いた`(z, x, y)`）にそのフィーチャーが
        見つからなければNone。"""
        road = await self._region_service.inspected_road(osm_way_id)
        if road is None:
            return None
        lens = await self._lens.inspect(feature_key, *tile, bearing_deg, at, speed_kmh, cost_preference)
        if lens is None:
            return None
        return RoadInspection(highway=road.highway, tags=road.tags, lens=lens)
