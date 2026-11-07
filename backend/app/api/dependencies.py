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
from functools import partial
from typing import Annotated

from cachetools import LRUCache
from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.domain.route_request import RequestedConditions
from app.infrastructure.address_search import AddressSearchQuery
from app.infrastructure.basemap_client import BasemapClient
from app.infrastructure.database import get_route_generation_session_factory, get_session_factory
from app.infrastructure.db_status import DbStatusQuery
from app.infrastructure.derived_data_freshness import DerivedDataFreshnessQuery
from app.infrastructure.flood_client import new_flood_cache
from app.infrastructure.gsi_tile_client import NOT_FOUND_MAX_ENTRIES, GsiTileClient
from app.infrastructure.http_client import JMA_JSON_TIMEOUT, SLOW_JSON_TIMEOUT, TILE_PROXY_TIMEOUT, get_http_client
from app.infrastructure.jma_amedas_client import new_latest_time_cache, new_station_table_cache
from app.infrastructure.jma_tile_client import JmaTileClient, JmaTileSharedState
from app.infrastructure.jma_warning_client import new_area_data_cache, new_warning_cache
from app.infrastructure.jma_warning_timeline_client import new_timeline_cache
from app.infrastructure.material_coverage import MaterialCoverageQuery
from app.infrastructure.place_area_query import PlaceAreaQuery
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.infrastructure.stop_place_search import StopPlaceSearchQuery
from app.infrastructure.tuning_overrides import TuningOverrideStore
from app.infrastructure.wbgt_client import new_forecast_cache, new_point_master_cache
from app.services.db_status_service import DbStatusService
from app.services.derived_data_freshness_service import DerivedDataFreshnessService
from app.services.feature_materials import FeatureMaterialService
from app.services.flood_service import FloodService
from app.services.graph_service import GraphService, SearchMemory
from app.services.jma_amedas_service import JmaAmedasService
from app.services.landcover_tile_service import get_landcover_tile
from app.services.lens_service import LensService
from app.services.material_coverage_service import MaterialCoverageService
from app.services.nearest_point_areas import new_cells_cache
from app.services.place_search_service import PlaceSearchReads, PlaceSearchService
from app.services.region_service import RoadInspectorService, RegionService
from app.services.route_generation_setup import (
    RouteGenerationSetup,
    assemble_route_generation_setup,
)
from app.services.cost_axis_service import CostAxisAdminService
from app.services.road_class_service import RoadClassAdminService
from app.services.tuning_service import TuningService
from app.services.warning_service import WarningService
from app.services.warning_timeline_service import WarningTimelineService
from app.services.wbgt_service import WbgtService
from app.services.weather_service import WeatherService


#: DBのセッション工場。タイル配信と同じ短いcommand_timeoutのものと、ルート生成・全表走査の集計が使う長いもの。
TileSessions = Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)]
LongSessions = Annotated[async_sessionmaker[AsyncSession], Depends(get_route_generation_session_factory)]


#: 気象の取得のプロセス内キャッシュ。サービス・クライアントはリクエストごとに作られるため、プロセスの側で持つ。
#: 地域マスタは警報と洪水予報で共有する。
_area_data_cache = new_area_data_cache()
_warning_cache = new_warning_cache()
_timeline_cache = new_timeline_cache()
_flood_cache = new_flood_cache()
_station_table_cache = new_station_table_cache()
_latest_time_cache = new_latest_time_cache()
_station_cells_cache = new_cells_cache()
_point_master_cache = new_point_master_cache()
_forecast_cache = new_forecast_cache()
_point_cells_cache = new_cells_cache()
_jma_tile_shared = JmaTileSharedState()
_weather_service = WeatherService()


def get_weather_service():
    return _weather_service


def get_warning_service():
    return WarningService(get_http_client(JMA_JSON_TIMEOUT), area_data_cache=_area_data_cache, warning_cache=_warning_cache)


def get_warning_timeline_service():
    return WarningTimelineService(
        get_http_client(JMA_JSON_TIMEOUT), area_data_cache=_area_data_cache, timeline_cache=_timeline_cache
    )


def get_amedas_service():
    return JmaAmedasService(
        get_http_client(JMA_JSON_TIMEOUT),
        get_jma_tile_client(),
        station_table_cache=_station_table_cache,
        latest_time_cache=_latest_time_cache,
        cells_cache=_station_cells_cache,
    )


def get_wbgt_service():
    return WbgtService(
        get_http_client(SLOW_JSON_TIMEOUT),
        point_master_cache=_point_master_cache,
        forecast_cache=_forecast_cache,
        cells_cache=_point_cells_cache,
    )


def get_flood_service():
    return FloodService(get_http_client(SLOW_JSON_TIMEOUT), area_data_cache=_area_data_cache, flood_cache=_flood_cache)


#: 同時に動く生成どうしが分け合うメモリ。生成ごとのサービスはリクエストごとに作られるため、プロセスの側で持つ。
_search_memory = SearchMemory()


@asynccontextmanager
async def _open_route_generation_setup(
    long_sessions: async_sessionmaker[AsyncSession], requested: RequestedConditions
) -> AsyncIterator[RouteGenerationSetup]:
    """ルート生成ジョブが使う`RouteGenerationSetup`を組み立てる非同期コンテキストマネージャ。"""
    async with long_sessions() as session:
        graph_service = GraphService(RoadGraphRepository(session), _search_memory)
        try:
            yield assemble_route_generation_setup(graph_service, get_weather_service(), requested)
        finally:
            graph_service.release_search_memory()


RouteGenerationSetupOpener = Callable[[RequestedConditions], AbstractAsyncContextManager[RouteGenerationSetup]]


def get_route_generation_setup_opener(long_sessions: LongSessions) -> RouteGenerationSetupOpener:
    """ルート生成ジョブがエンジンを組むときの開き方。

    セッションそのものではなく開き方を注入する——ジョブは応答の送出後も走り続け、リクエストの
    DBセッションはハンドラ関数が返った時点で閉じられるため、ジョブが自分でセッションを開いて閉じる。
    """
    return partial(_open_route_generation_setup, long_sessions)


LandcoverTileReader = Callable[[int, int, int], Awaitable[bytes]]


def get_landcover_tile_reader() -> LandcoverTileReader:
    """土地被覆のタイル（z, x, y）を読む口。ラスタはプロセスが開いたものを共有し、要求ごとに組む部品が無いので、
    読む関数を配る。"""
    return get_landcover_tile


@asynccontextmanager
async def open_region_service(tile_sessions: async_sessionmaker[AsyncSession]) -> AsyncIterator[RegionService]:
    """地域サービスの開き方。HTTPの要求の外（定期ジョブ）と、要求の依存が開く。"""
    async with tile_sessions() as session:
        yield RegionService(repository=RoadGraphRepository(session))


async def get_region_service(tile_sessions: TileSessions):
    async with open_region_service(tile_sessions) as region_service:
        yield region_service


@asynccontextmanager
async def _open_place_search_reads(tile_sessions: async_sessionmaker[AsyncSession]) -> AsyncIterator[PlaceSearchReads]:
    async with tile_sessions() as session:
        yield PlaceSearchReads(RegionService(repository=RoadGraphRepository(session)), AddressSearchQuery(session),
                               StopPlaceSearchQuery(session), PlaceAreaQuery(session))


def get_place_search_service(tile_sessions: TileSessions):
    return PlaceSearchService(partial(_open_place_search_reads, tile_sessions))


async def get_feature_material_service(tile_sessions: TileSessions):
    async with tile_sessions() as session:
        yield FeatureMaterialService(RoadGraphRepository(session))


def get_lens_service(weather_service: WeatherService = Depends(get_weather_service)) -> LensService:
    """地図のレンズの道ごとの値。DBを読まない（取込範囲全体の道の網から求める）。"""
    return LensService(weather_service)


async def get_road_inspector_service(tile_sessions: TileSessions, lens: LensService = Depends(get_lens_service)):
    """道の窓。道の一次属性を引くセッションと、DBを読まないレンズの値。"""
    async with tile_sessions() as session:
        yield RoadInspectorService(RegionService(repository=RoadGraphRepository(session)), lens)


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
async def get_tuning_service(tile_sessions: TileSessions):
    async with tile_sessions() as session:
        yield TuningService(session, TuningOverrideStore(session))


async def get_road_class_admin_service(tile_sessions: TileSessions):
    async with tile_sessions() as session:
        yield RoadClassAdminService(session)


async def get_cost_axis_admin_service(tile_sessions: TileSessions):
    async with tile_sessions() as session:
        yield CostAxisAdminService(session)


async def get_material_coverage_service(long_sessions: LongSessions):
    async with long_sessions() as session:
        yield MaterialCoverageService(MaterialCoverageQuery(session))


async def get_db_status_service(long_sessions: LongSessions):
    async with long_sessions() as session:
        yield DbStatusService(DbStatusQuery(session))


async def get_derived_data_freshness_service(long_sessions: LongSessions):
    async with long_sessions() as session:
        yield DerivedDataFreshnessService(DerivedDataFreshnessQuery(session))
