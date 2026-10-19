"""APIのDI工場（FastAPIのDepends用ファクトリ）。

サービスの組み立て方（どのクライアント・タイムアウト・リポジトリを注入するか）はここに集約する。
公開関数は注入の口だけで、ルーターは`Depends`で受け取る（部品を束ねる判断は`services/`が持つ）。
配るのは組み立てた部品（サービスの実体・素通しの中継のクライアント・開き方）だけで、セッション・リポジトリ・
呼び出しの結果は配らない（docs/architecture/directory-layout.md「backend」の`api/`）。
定期ジョブも同じ部品ならここの口を呼ぶ。HTTPの経路に無い部品（起動時の軸定義・較正値の読み込み、
MSMの同期）だけは`main.py`が組み立てる。
"""

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager

from cachetools import LRUCache, TTLCache
from fastapi import Depends

from app.config import settings
from app.domain.route_request import RequestedConditions
from app.infrastructure.address_search import AddressSearchQuery
from app.infrastructure.axis_definition_repository import AxisDefinitionRepository
from app.infrastructure.basemap_client import BasemapClient
from app.infrastructure.database import get_route_generation_session_factory, get_session_factory
from app.infrastructure.db_status import DbStatusQuery
from app.infrastructure.derived_data_freshness import DerivedDataFreshnessQuery
from app.infrastructure.flood_client import new_flood_cache
from app.infrastructure.gsi_tile_client import NOT_FOUND_MAX_ENTRIES, GsiTileClient
from app.infrastructure.http_client import JSON_API_TIMEOUT, TILE_PROXY_TIMEOUT, get_http_client
from app.infrastructure.jma_amedas_client import new_latest_time_cache, new_station_table_cache
from app.infrastructure.jma_tile_client import JmaTileClient, JmaTileSharedState
from app.infrastructure.jma_warning_client import new_area_data_cache, new_warning_cache
from app.infrastructure.material_coverage import MaterialCoverageQuery
from app.infrastructure.place_area_query import PlaceAreaQuery
from app.infrastructure.region_tile_cache import TileResponse
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.infrastructure.stop_place_search import StopPlaceSearchQuery
from app.infrastructure.wbgt_client import new_forecast_cache, new_point_master_cache
from app.services.axis_preview_service import AxisPreviewService, new_sample_cache
from app.services.axis_registry_service import AxisRegistryAdminService
from app.services.db_status_service import DbStatusService
from app.services.dedicated_way_values import (
    DraftWayValueLensBuilder,
    axis_way_value_lens,
    draft_axis_way_value_lens,
    material_service_builder,
)
from app.services.derived_data_freshness_service import DerivedDataFreshnessService
from app.services.feature_materials import FeatureMaterialService
from app.services.flood_service import FloodService
from app.services.graph_service import GraphService
from app.services.jma_amedas_service import JmaAmedasService
from app.services.landcover_tile_service import get_landcover_tile
from app.services.material_coverage_service import MaterialCoverageService
from app.services.nearest_point_areas import new_cells_cache
from app.services.place_search_service import PlaceSearchReads, PlaceSearchService
from app.services.region_service import AxisInspectorService, RegionService
from app.services.route_generation_setup import (
    RouteGenerationSetup,
    assemble_route_generation_setup,
)
from app.services.tuning_service import TuningService
from app.services.warning_service import WarningService
from app.services.wbgt_service import WbgtService
from app.services.weather_service import WeatherService


#: 気象の取得のプロセス内キャッシュ。サービス・クライアントはリクエストごとに作られるため、プロセスの側で持つ。
#: 地域マスタは警報と洪水予報で共有する。
_area_data_cache = new_area_data_cache()
_warning_cache = new_warning_cache()
_flood_cache = new_flood_cache()
_station_table_cache = new_station_table_cache()
_latest_time_cache = new_latest_time_cache()
_station_cells_cache = new_cells_cache()
_point_master_cache = new_point_master_cache()
_forecast_cache = new_forecast_cache()
_point_cells_cache = new_cells_cache()
_jma_tile_shared = JmaTileSharedState()
#: 雨の材料を実体の中に持つため、プロセスに1つ。
_weather_service = WeatherService()


def get_weather_service():
    return _weather_service


def get_warning_service():
    return WarningService(get_http_client(JSON_API_TIMEOUT), area_data_cache=_area_data_cache, warning_cache=_warning_cache)


def get_amedas_service():
    return JmaAmedasService(
        get_http_client(JSON_API_TIMEOUT),
        get_jma_tile_client(),
        station_table_cache=_station_table_cache,
        latest_time_cache=_latest_time_cache,
        cells_cache=_station_cells_cache,
    )


def get_wbgt_service():
    return WbgtService(
        get_http_client(JSON_API_TIMEOUT),
        point_master_cache=_point_master_cache,
        forecast_cache=_forecast_cache,
        cells_cache=_point_cells_cache,
    )


def get_flood_service():
    return FloodService(get_http_client(JSON_API_TIMEOUT), area_data_cache=_area_data_cache, flood_cache=_flood_cache)


@asynccontextmanager
async def _open_route_generation_setup(requested: RequestedConditions) -> AsyncIterator[RouteGenerationSetup]:
    """ルート生成ジョブが使う`RouteGenerationSetup`を組み立てる非同期コンテキストマネージャ。"""
    async with get_route_generation_session_factory()() as session:
        yield assemble_route_generation_setup(
            GraphService(repository=RoadGraphRepository(session)), get_weather_service(), requested,
        )


RouteGenerationSetupOpener = Callable[[RequestedConditions], AbstractAsyncContextManager[RouteGenerationSetup]]


def get_route_generation_setup_opener() -> RouteGenerationSetupOpener:
    """ルート生成ジョブがエンジンを組むときの開き方。

    セッションそのものではなく開き方を注入する——ジョブは応答の送出後も走り続け、リクエストの
    DBセッションはハンドラ関数が返った時点で閉じられるため、ジョブが自分でセッションを開いて閉じる。
    """
    return _open_route_generation_setup


LandcoverTileReader = Callable[[int, int, int], Awaitable[TileResponse | None]]


def get_landcover_tile_reader() -> LandcoverTileReader:
    """土地被覆のタイル（z, x, y）を読む口。ラスタはプロセスが開いたものを共有し、要求ごとに組む部品が無いので、
    読む関数を配る。"""
    return get_landcover_tile


#: 軸スタジオの分布の標本。サービスはリクエストごとに作られるため、プロセスの側で持つ。
_axis_preview_sample_cache = new_sample_cache()


def get_axis_preview_sample_cache() -> TTLCache:
    return _axis_preview_sample_cache


async def get_axis_preview_service(sample_cache: TTLCache = Depends(get_axis_preview_sample_cache)):
    """軸スタジオの実データの読み出し。全表走査寄りのため、タイル配信保護用の短いcommand_timeoutで
    キャンセルされないようルート生成用のセッション工場を使う。"""
    async with get_route_generation_session_factory()() as session:
        yield AxisPreviewService(RoadGraphRepository(session), sample_cache)


@asynccontextmanager
async def open_region_service() -> AsyncIterator[RegionService]:
    """地域サービスの開き方。HTTPの要求の外（定期ジョブ）と、要求の依存が開く。"""
    async with get_session_factory()() as session:
        yield RegionService(repository=RoadGraphRepository(session))


async def get_region_service():
    async with open_region_service() as region_service:
        yield region_service


@asynccontextmanager
async def _open_place_search_reads() -> AsyncIterator[PlaceSearchReads]:
    async with get_session_factory()() as session:
        yield PlaceSearchReads(RegionService(repository=RoadGraphRepository(session)), AddressSearchQuery(session),
                               StopPlaceSearchQuery(session), PlaceAreaQuery(session))


def get_place_search_service():
    return PlaceSearchService(_open_place_search_reads)


async def get_dedicated_way_value_service(
    axis_id: str,
    weather_service: WeatherService = Depends(get_weather_service),
):
    """地図のレンズ（軸の値の配信）の、軸id駆動な単一の注入点。

    `axis_id`はパスパラメータで、ルーター側と同名でなければFastAPIが解決できない。
    router側で軸ごとのサービスをそれぞれ`Depends`するとリクエストごとにDBセッションが
    重複して開くため、この関数自体が軸から配信を組んで1セッションで済ませる。公開軸でない`axis_id`には
    Noneを返し、呼び出し元が404を返す。
    """
    async with get_session_factory()() as session:
        repository = RoadGraphRepository(session)
        yield axis_way_value_lens(
            axis_id, FeatureMaterialService(repository), material_service_builder(repository, weather_service)
        )


async def get_draft_way_value_lens_builder(
    weather_service: WeatherService = Depends(get_weather_service),
) -> AsyncIterator[DraftWayValueLensBuilder]:
    """軸スタジオの較正の地図が、下書きの形で軸の値を求めるレンズの組み立て。地図のレンズと同じく、タイルの材料と
    配信のサービスを1セッションで引く。軸は本文にあるため、組み立ては呼び出し元がする。"""
    async with get_session_factory()() as session:
        repository = RoadGraphRepository(session)
        feature_materials = FeatureMaterialService(repository)
        build_service = material_service_builder(repository, weather_service)
        yield lambda axis_id, shape: draft_axis_way_value_lens(axis_id, shape, feature_materials, build_service)


async def get_axis_inspector_service(weather_service: WeatherService = Depends(get_weather_service)):
    """区間インスペクタ。道の読み出しと、地図の配信と同じタイルの材料・配信のサービスの値を、同じセッションで順に引く
    ——別々に開くと、先に引いたセッションが要求の終わりまで接続を持ったまま、後の読み出しがもう1本を取る。"""
    async with get_session_factory()() as session:
        repository = RoadGraphRepository(session)
        yield AxisInspectorService(
            RegionService(repository=repository),
            FeatureMaterialService(repository),
            material_service_builder(repository, weather_service),
        )


def get_basemap_client():
    return BasemapClient(get_http_client(TILE_PROXY_TIMEOUT), settings.basemap_public_base_url)


def get_jma_tile_client():
    return JmaTileClient(get_http_client(TILE_PROXY_TIMEOUT), _jma_tile_shared)


#: 整備区域外の記憶。クライアントはリクエストごとに作られるため、プロセスの側で持つ。
_gsi_not_found_paths: LRUCache = LRUCache(maxsize=NOT_FOUND_MAX_ENTRIES)


def get_gsi_tile_client():
    return GsiTileClient(get_http_client(TILE_PROXY_TIMEOUT), _gsi_not_found_paths)


# 以下の管理API向けのうち、書き込み・1テーブル読みで足りるものはタイル配信と同じ
# セッション工場を使い、全表走査を伴う集計はルート生成用の長いcommand_timeoutを使う
# （短い方だと集計が最後まで走らずキャンセルされる）。
async def get_axis_registry_admin_service():
    async with get_session_factory()() as session:
        yield AxisRegistryAdminService(AxisDefinitionRepository(session))


async def get_tuning_service():
    async with get_session_factory()() as session:
        yield TuningService(session)


async def get_material_coverage_service():
    async with get_route_generation_session_factory()() as session:
        yield MaterialCoverageService(MaterialCoverageQuery(session))


async def get_db_status_service():
    async with get_route_generation_session_factory()() as session:
        yield DbStatusService(DbStatusQuery(session))


async def get_derived_data_freshness_service():
    async with get_route_generation_session_factory()() as session:
        yield DerivedDataFreshnessService(DerivedDataFreshnessQuery(session))
