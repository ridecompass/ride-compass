from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import partial

from app.domain.axis_definitions import copy_axis_definitions, published_axis_order
from app.domain.axis_inspector import AxisInspectorResult, InspectorValues, inspector_values
from app.domain.dynamic_way_values import MissingConditions, WayValueQuery
from app.domain.landcover import LandcoverPercentages
from app.domain.route_preference import RoutePreference
from app.domain.region import BoundingBox, tile_bounds_lonlat
from app.domain.registry import TileKind
from app.domain.tuning import REBUILT_CLIENT_TUNING_IDS
from app.infrastructure.database import DB_UNAVAILABLE_ERRORS
from app.infrastructure.debug_log import log_external_call, log_throttled_warning, mark_failed
from app.infrastructure.point_tile_layers import PointTileLayer
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.infrastructure.vector_tile import ROAD_SURFACE_LAYER_NAME, encode_empty_tile
from app.infrastructure.media_types import MVT_CONTENT_TYPE
from app.infrastructure.region_tile_cache import TileResponse, serve_region_tile
from app.services.dedicated_way_values import FeatureMaterialSource, MaterialServiceBuilder, tile_axis_values
from app.services.tile_version_service import (
    TILE_SHAPES,
    current_tile_versions,
    prune_other_tile_generations,
    served_tile_version,
)

# z・x・yとその範囲（経度・緯度）から、PostGISが生成したタイル1枚を返す読み出し。
_TileReader = Callable[[int, int, int, BoundingBox], Awaitable[bytes | None]]


@dataclass(frozen=True)
class InspectedFeature:
    """区間インスペクタが評価するフィーチャー1つ。"""

    key: str
    #: そのフィーチャーを焼くタイル`(z, x, y)`。地図の配信がこのタイルで塗る値を、そのまま評価に使う。
    tile: tuple[int, int, int]
    landcover: LandcoverPercentages | None


@dataclass(frozen=True)
class InspectedRoad:
    highway: str
    tags: dict[str, str]
    #: 押したフィーチャー（その倍率で地図が塗る単位）。
    feature: InspectedFeature


class RegionService:
    """候補ルートに紐づかない「地域全体」のレイヤーを、XYZベクタタイルとして配る。

    生成したタイルは基礎地図タイルと同じファイルキャッシュへ置く。そのため管理画面からの
    一括クリア（`api/routers/basemap.py: basemap_refresh`）で両方とも消える。

    カバレッジ外・DB障害はいずれも空タイルを返す。取れなかったときに
    別の経路から取り直すフォールバックは持たない（背景は
    docs/records/decisions/pre-static-attributes-gate.md 決定2）。
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
        empty_tile: bytes,
        external_call_name: str,
        z: int,
        x: int,
        y: int,
    ) -> TileResponse:
        async def fetch_tile(fields: dict) -> bytes | None:
            """PostGIS側（ST_AsMVT）でタイル1枚分のMVTを丸ごと生成する。

            `read_tile`は「カバレッジ外はNone・カバレッジ内0件は空バイト列」という契約を
            満たすこと。DB障害もNoneへ倒し、PostGIS停止時も地図表示全体を落とさない。
            """
            try:
                # カバレッジ判定（取込の宣言した範囲か）はMVT生成と同じ1クエリへ畳み込まれて
                # いる（DBの往復1回分を節約。repository側のdocstring参照）。
                tile_bytes = await read_tile(z, x, y, tile_bounds_lonlat(z, x, y))
            except DB_UNAVAILABLE_ERRORS as exc:
                mark_failed(fields, exc)
                return None
            if tile_bytes is None:
                # 取込範囲外は取得できないのが正常な場合で、WARNINGにしない（地図を範囲の外へ動かすたびに出る）。
                fields["postgis"] = "uncovered"
                return None
            fields["postgis"] = "hit"
            return tile_bytes

        return await serve_region_tile(
            kind=kind,
            generation=await served_tile_version(self._repository, TILE_SHAPES[kind]),
            z=z,
            x=x,
            y=y,
            extension="pbf",
            empty_tile=empty_tile,
            content_type=MVT_CONTENT_TYPE,
            external_call_name=external_call_name,
            fetch_tile=fetch_tile,
        )

    async def get_road_surface_tile(self, z: int, x: int, y: int) -> TileResponse:
        return await self._get_tile(
            read_tile=self._repository.get_road_surface_tile_mvt,
            kind="road_surface",
            empty_tile=encode_empty_tile(ROAD_SURFACE_LAYER_NAME),
            external_call_name="region:road-surface-tile",
            z=z,
            x=x,
            y=y,
        )

    async def get_point_tile(self, layer: PointTileLayer, z: int, x: int, y: int) -> TileResponse:
        """点のレイヤー（`infrastructure/point_tile_layers.py`）のタイル。どのレイヤーも同じ道で配る。"""
        return await self._get_tile(
            read_tile=partial(self._repository.get_tile_mvt, layer.sql, layer.source_layer),
            kind=layer.name,
            empty_tile=encode_empty_tile(layer.source_layer),
            external_call_name=f"region:{layer.name}-tile",
            z=z,
            x=x,
            y=y,
        )

    async def inspected_road(self, osm_way_id: int, feature_key: str, z: int, x: int, y: int) -> InspectedRoad | None:
        """区間インスペクタが評価する、押したフィーチャー（タイル`(z, x, y)`が焼いた`feature_key`）と、道の一次属性。

        引き直しの鍵はタイルへ焼き込み済みのosm_way_idで、クリック地点の緯度経度から道を空間マッチで選ばない——交差点
        付近など複数の道路が近接する場所で、実際にクリックされたフィーチャーとは別の道路を拾う。

        該当way不在・DB例外はいずれもNoneへ倒す（タイル配信と同じグレースフルデグレード方針）。
        """
        with log_external_call("region:axis-inspector", osm_way_id=osm_way_id) as fields:
            try:
                way_tags_result = await self._repository.get_way_tags_by_osm_way_id(osm_way_id)
                if way_tags_result is None:
                    fields["lookup"] = "not_found"
                    return None
                feature = InspectedFeature(feature_key, (z, x, y),
                                           await self._repository.get_feature_landcover(osm_way_id, feature_key))
            except DB_UNAVAILABLE_ERRORS as exc:
                mark_failed(fields, exc)
                return None
            fields["lookup"] = "ok"
            highway, tags = way_tags_result
            return InspectedRoad(highway, tags, feature)

    async def get_accident_years(self) -> list[int]:
        """事故データの収録年。地図の説明文へ配る。

        表示側が年を文字列で持つと、取り込み直したときに黙って食い違う。年の正本は
        今の事故の数を数えた取込の宣言（`source_runs.profile`）だけにする。

        DB例外は空へ倒す。
        """
        with log_external_call("region:accident-years-covered") as fields:
            try:
                years = await self._repository.get_accident_years()
            except DB_UNAVAILABLE_ERRORS as exc:
                mark_failed(fields, exc)
                return []
            fields["years_covered"] = len(years)
            return years

    async def get_rebuilt_client_tuning(self) -> dict[str, float]:
        """フロントへ配る較正値のうち作り直しで効くもの（`REBUILT_CLIENT_TUNING_IDS`）の、作り直しに使った値。

        DB例外は空へ倒す（画面は引けない値を文に出さない）。管理画面の今の値や既定で埋めると、派生の値と食い違う数を出す。
        """
        with log_external_call("region:rebuilt-client-tuning") as fields:
            try:
                return await self._repository.get_recorded_tuning(REBUILT_CLIENT_TUNING_IDS)
            except DB_UNAVAILABLE_ERRORS as exc:
                mark_failed(fields, exc)
                return {}

    async def get_ingested_area(self) -> BoundingBox | None:
        """サービスの対象範囲（取り込んだ道路の範囲）。気象庁タイルのプリウォームが、ここから
        範囲を引く——範囲を持つのは取込の宣言だけで、取込範囲を広げればタイルも同じ範囲へ広がる。

        道路をまだ取り込んでいない・DB例外のときはNone（どちらもWARNING）。
        """
        with log_external_call("region:ingested-area") as fields:
            try:
                area = await self._repository.get_ingested_area()
            except DB_UNAVAILABLE_ERRORS as exc:
                mark_failed(fields, exc)
                return None
            fields["ingested"] = area is not None
            if area is None:
                log_throttled_warning("region:ingested-area", "道路の取込が成功した記録が無く、対象範囲が決まらない")
            return area


class AxisInspectorService:
    """区間インスペクタ。押したフィーチャー（その倍率で地図が塗る区間か道1本）の公開軸の得点を、地図の配信がそれを塗る
    タイルの値（`tile_axis_values`）から出す——地図の色と内訳の数字が、同じ評価の同じ値になる。"""

    def __init__(
        self,
        region_service: RegionService,
        feature_materials: FeatureMaterialSource,
        build_service: MaterialServiceBuilder,
    ):
        self._region_service = region_service
        self._feature_materials = feature_materials
        self._build_service = build_service

    async def inspect(
        self,
        osm_way_id: int,
        feature_key: str,
        z: int,
        x: int,
        y: int,
        query: WayValueQuery,
        preference: RoutePreference | None,
    ) -> AxisInspectorResult | None:
        """`preference`は合成に使う重み。利用者がいま設定している重みを渡す——ルート生成と同じ重みで見せないと、
        重みを0にした軸まで効いて見える。省略すると既定の重み。

        `query`の条件が欠けて値の出ない軸は、評価できない軸になる（地図の配信なら欠けを断る）。
        """
        road = await self._region_service.inspected_road(osm_way_id, feature_key, z, x, y)
        if road is None:
            return None
        definitions = copy_axis_definitions()
        published = published_axis_order(definitions)
        weights = preference or RoutePreference()

        async def values(feature: InspectedFeature) -> InspectorValues:
            painted = await tile_axis_values(
                published, definitions, self._feature_materials, self._build_service, *feature.tile, query,
                feature_key=feature.key, as_difficulty=True,
            )
            scores = {axis_id: None if isinstance(by_key, MissingConditions) else by_key.get(feature.key)
                      for axis_id, by_key in painted.items()}
            return inspector_values({axis_id: scores[axis_id] for axis_id in published}, feature.landcover, weights)

        return AxisInspectorResult(
            highway=road.highway, tags=road.tags, values=await values(road.feature))
