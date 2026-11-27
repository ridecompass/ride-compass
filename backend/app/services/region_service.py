import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from functools import partial

import shapely

from app.domain.cost_preference import CostPreference
from app.domain.lens_values import RoadInspection
from app.domain.region import ROAD_TILE_MIN_ZOOM, ROADS_AT_LIMIT, BoundingBox, RoadAt, tile_bounds_lonlat
from app.domain.registry import TileKind
from app.domain.feature_materials import FeatureMaterials
from app.domain.road_classes import RoadClassDefinitions, current_road_classes
from app.domain.road_features import (
    MapFeatures,
    feature_lines,
    feature_materials,
    feature_rows,
    map_features_in,
    map_features_near,
    road_layer_values,
)
from app.domain.timed_regulations import regulated_rows_within, regulation_variant
from app.domain.model_settings import current_model_settings
from app.domain.road_class_catalog import RoadClassCatalog, road_class_catalog
from app.domain.strict_model import StrictModel
from app.domain.tuning import REBUILT_CLIENT_TUNING_IDS, client_tuning_values
from app.infrastructure.debug_log import log_external_call
from app.infrastructure.point_tile_layers import PointTileLayer
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.infrastructure import road_network_store
from app.infrastructure.vector_tile import ROAD_FEATURE_PROPERTIES, ROAD_SURFACE_LAYER_NAME, encode_empty_tile
from app.infrastructure.media_types import MVT_CONTENT_TYPE
from app.infrastructure.region_tile_cache import MVT_TILE_GENERATIONS, serve_region_tile
from app.services.lens_service import LensService
from app.services.time_frame_service import TimeFrameService

logger = logging.getLogger("ridecompass.region_service")

# z・x・yとその範囲（経度・緯度）から、PostGISが生成したタイル1枚を返す読み出し。
_TileReader = Callable[[int, int, int, BoundingBox], Awaitable[bytes | None]]


@dataclass(frozen=True)
class _InspectedRoad:
    highway: str
    tags: dict[str, str]


class ClientConfigResponse(StrictModel):
    # フロントが使う較正値（id → いま効いている値、`domain/tuning.py`が宣言。作り直しで効く値は作り直しに使った値）。
    client_tuning: dict[str, float]
    # 事故データの収録年（地図の点が読む取込の宣言そのもの）。地図の説明文が範囲を書くために使う。表示側に文字列で
    # 持つと、取り込み直したときに黙って食い違う。
    accident_years: list[int]
    # 道の区分（`domain/road_class_catalog.py: road_class_catalog`）。
    road_classes: RoadClassCatalog


class RegionService:
    """候補ルートに紐づかない「地域全体」のレイヤーを、XYZベクタタイルとして配る。

    カバレッジ外は空タイルを返し、DB障害は投げる（503）。取れなかったときに別の経路から取り直すフォールバックは持たない。
    """

    def __init__(self, repository: RoadGraphRepository):
        self._repository = repository

    async def _get_tile(
        self,
        *,
        read_tile: _TileReader,
        kind: TileKind,
        empty_tile: bytes,
        external_call_name: str,
        z: int, x: int, y: int,
        variant: str = "",
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
            generation=MVT_TILE_GENERATIONS[kind],
            z=z, x=x, y=y,
            extension="pbf",
            empty_tile=empty_tile,
            content_type=MVT_CONTENT_TYPE,
            external_call_name=external_call_name,
            fetch_tile=fetch_tile,
            variant=variant,
        )

    async def get_road_surface_tile(self, z: int, x: int, y: int, frame: str | None, time_frames: TimeFrameService) -> bytes:
        """地図の道の線のタイル。フィーチャーごとの地図の線の層の値（`road_layer_values`）を焼く。路面タイルのコマの印`frame`を
        渡すと、道ごとの鍵を焼くズーム（`ROAD_TILE_MIN_ZOOM`以上）では、規制の当たる道の区分をそのコマの始まりの時刻に効く規制で
        焼き、持ちはタイルの規制の効き方（`domain/timed_regulations.py: regulation_variant`）で分ける。引いたズームは時刻で変わらない
        規制だけで焼き、印を確かめない（地図は時刻で変わる規制の層を、そのズームでは描かない）。今の一覧に無い印は投げる。"""
        definitions = current_road_classes()
        timed_at = await time_frames.road_surface_at(frame) if z >= ROAD_TILE_MIN_ZOOM else None
        variant = ""
        if timed_at is not None:
            variant = await asyncio.to_thread(_regulation_variant, tile_bounds_lonlat(z, x, y), timed_at)
            if not variant:
                timed_at = None

        async def read_tile(z: int, x: int, y: int, bbox: BoundingBox) -> bytes | None:
            # 道路網を読むのと、引いたズームのタイルの数万本の道の値と形を並べるのは、イベントループの外で行う。
            keys, shapes, layer_values = await asyncio.to_thread(_road_surface_features, z, bbox, definitions, timed_at)
            return await self._repository.get_road_surface_tile_mvt(z, x, y, bbox, keys, shapes, layer_values)

        return await self._get_tile(
            read_tile=read_tile,
            kind="road_surface",
            empty_tile=encode_empty_tile(ROAD_SURFACE_LAYER_NAME),
            external_call_name="region:road-surface-tile",
            z=z, x=x, y=y, variant=variant,
        )

    async def get_point_tile(self, layer: PointTileLayer, z: int, x: int, y: int) -> bytes:
        """点のレイヤー（`infrastructure/point_tile_layers.py`）のタイル。どのレイヤーも同じ道で配る。"""
        return await self._get_tile(
            read_tile=partial(self._repository.get_tile_mvt, layer.sql, layer.source_layer),
            kind=layer.name,
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
        """押した所に近い道（近い順、最大`ROADS_AT_LIMIT`本）。道のタイルを読まずに道を押せるようにする。プロパティの材料は、
        路面タイルが塗るのと同じ道路網の配列のフィーチャーの値。"""
        with log_external_call("region:roads-at", z=z) as fields:
            found, materials, shapes = await asyncio.to_thread(_roads_at, lon, lat, z, radius_m)
            names = await self._repository.get_way_names(sorted(set(found.way_ids))) if len(found) else {}
            fields["found"] = len(found)
        roads = []
        for row, (key, way_id) in enumerate(zip(found.keys, found.way_ids, strict=True)):
            name, ref = names.get(way_id, (None, None))
            # 道の窓が、小窓に出た値と同じ行を曖昧さ無く引き直すための識別子（道の番号）も載せる。
            properties = {ROAD_FEATURE_PROPERTIES["feature_key"]: key, ROAD_FEATURE_PROPERTIES["way_id"]: way_id,
                          **{ROAD_FEATURE_PROPERTIES[column]: value for column, value in (("name", name), ("ref", ref))
                             if value is not None}}
            roads.append(RoadAt(properties={**properties, **materials.tile_properties(row)}, shape=shapes[row]))
        return roads

    async def get_client_config(self) -> ClientConfigResponse:
        """画面が起動のときに1回取る、再デプロイなしに変わる値。区分と較正値はプロセス内の値で、事故の収録年と作り直しで効く
        較正値だけがDBを見る。"""
        settings = current_model_settings()
        with log_external_call("region:rebuilt-client-tuning"):
            rebuilt = await self._repository.get_recorded_tuning(REBUILT_CLIENT_TUNING_IDS)
        # 事故の収録年の正本は、地図の点が読む取込の素性（`source_runs.origin`）だけにする。
        with log_external_call("region:accident-years-covered") as fields:
            years = await self._repository.get_accident_years()
            fields["years_covered"] = len(years)
        return ClientConfigResponse(
            client_tuning={**client_tuning_values(settings.tuning), **rebuilt},
            accident_years=years,
            road_classes=road_class_catalog(settings.road_classes, settings.tuning),
        )

    async def get_ingested_area(self) -> BoundingBox | None:
        """サービスの対象範囲（取り込んだ道路の範囲）。気象庁タイルのプリウォームが、ここから
        範囲を引く——範囲を持つのは取込の宣言だけで、取込範囲を広げればタイルも同じ範囲へ広がる。

        道路をまだ取り込んでいないときはNone（WARNING）。
        """
        with log_external_call("region:ingested-area") as fields:
            area = await self._repository.get_ingested_area()
            fields["ingested"] = area is not None
            if area is None:
                logger.warning("道路の取込が成功した記録が無く、対象範囲が決まらない")
            return area


def _regulation_variant(bounds: BoundingBox, at: datetime) -> str:
    """範囲`bounds`の路面タイルの、時刻`at`の規制の効き方の印。道路網を読むので、イベントループの外で呼ぶ。"""
    network = road_network_store.current()
    return regulation_variant(network, regulated_rows_within(
        network, bounds.min_longitude, bounds.min_latitude, bounds.max_longitude, bounds.max_latitude), at)


def _road_surface_features(z: int, bbox: BoundingBox, definitions: RoadClassDefinitions,
                           at: datetime | None) -> tuple[tuple[str, ...], list[bytes], dict[str, dict[str, str]]]:
    """路面タイルの、ズーム`z`・範囲`bbox`のフィーチャーの鍵と線の形（WKB）と地図の線の層の値（`road_layer_values`）。道路網を
    読むので、イベントループの外で呼ぶ。"""
    network = road_network_store.current()
    features = map_features_in(network, z, bbox.min_longitude, bbox.min_latitude, bbox.max_longitude, bbox.max_latitude)
    layer_values = road_layer_values(network, features.keys, features.way_ids, features.segment_indexes, definitions, at)
    return features.keys, shapely.to_wkb(feature_lines(network, features)).tolist(), layer_values


def _roads_at(lon: float, lat: float, z: int, radius_m: float
              ) -> tuple[MapFeatures, FeatureMaterials, list[list[tuple[float, float]]]]:
    """押した所に近い道のフィーチャー（`map_features_near`）と、路面タイルが塗るのと同じ材料と、タイルで切らない線の全体（経度,
    緯度）。道路網を読むので、イベントループの外で呼ぶ。"""
    network = road_network_store.current()
    found = map_features_near(network, z, lon, lat, radius_m, ROADS_AT_LIMIT)
    edge_rows, way_rows = feature_rows(network, found.way_ids, found.segment_indexes)
    shapes = [[(float(x), float(y)) for x, y in shapely.get_coordinates(line)] for line in feature_lines(network, found)]
    return found, feature_materials(network, found.keys, edge_rows, way_rows), shapes


class RoadInspectorService:
    """道の窓。押した道の一次属性と、押したフィーチャーのレンズの値を、地図のレンズと同じ口
    （`services/lens_service.py: LensService.inspect`）から出す——地図の色と道の窓の数字が同じ値になる。"""

    def __init__(self, region_service: RegionService, lens: LensService):
        self._region_service = region_service
        self._lens = lens

    async def inspect(
        self, osm_way_id: int, feature_key: str, tile: tuple[int, int, int], bearing_deg: float, frame: str | None,
        speed_kmh: float, cost_preference: CostPreference,
    ) -> RoadInspection | None:
        """押した道（osm_way_id）か、タイル`tile`（押したフィーチャー`feature_key`を焼いた`(z, x, y)`）にそのフィーチャーが
        見つからなければNone。"""
        road = await self._region_service.inspected_road(osm_way_id)
        if road is None:
            return None
        lens = await self._lens.inspect(feature_key, *tile, bearing_deg, frame, speed_kmh, cost_preference)
        if lens is None:
            return None
        return RoadInspection(highway=road.highway, tags=road.tags, lens=lens)
