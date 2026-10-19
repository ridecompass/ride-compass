from datetime import datetime
from typing import TypeVar

from fastapi import APIRouter, Depends, HTTPException, Request

from app.api.dependencies import (
    get_amedas_service,
    get_flood_service,
    get_warning_service,
    get_wbgt_service,
)
from app.api.rate_limit import enforce_rate_limit
from app.config import settings
from app.domain.geo import Latitude, Longitude
from app.domain.jma_amedas import AmedasObservation
from app.domain.route import Coordinates
from app.domain.time_zone import JST
from app.services.flood_service import FloodForecasts, FloodService
from app.services.warning_service import WarningService, WeatherWarnings
from app.services.wbgt_service import WbgtService, WbgtStatus
from app.services.jma_amedas_service import JmaAmedasService


router = APIRouter()

# 警報系バッジの失敗の文。画面は出所の名前を前に付けて出す（「警報・注意報: 取得できませんでした。」）。
_BADGE_SOURCE_UNAVAILABLE = "取得できませんでした。"

_T = TypeVar("_T")


def _or_502(value: _T | None, detail: str) -> _T:
    if value is None:
        raise HTTPException(status_code=502, detail=detail)
    return value


@router.get("/api/weather/warnings", response_model=WeatherWarnings)
async def get_weather_warnings(
    http_request: Request,
    latitude: Latitude,
    longitude: Longitude,
    warning_service: WarningService = Depends(get_warning_service),
) -> WeatherWarnings:
    """出発地点近傍のJMA警報・注意報を、サイクリングに関連する種別へ絞ってバッジ用に返す。
    地点→区域→警報エリアの解決か、警報自体の取得に失敗したら502（空の応答は「警報なし」だけを表す）。"""
    enforce_rate_limit(http_request, "weather-warnings", settings.weather_warnings_rate_limit_per_minute)
    return _or_502(
        await warning_service.get_warnings(Coordinates(latitude=latitude, longitude=longitude)),
        _BADGE_SOURCE_UNAVAILABLE,
    )


@router.get("/api/weather/wbgt", response_model=WbgtStatus)
async def get_wbgt(
    http_request: Request,
    latitude: Latitude,
    longitude: Longitude,
    wbgt_service: WbgtService = Depends(get_wbgt_service),
) -> WbgtStatus:
    """出発地点近傍の暑さ指数（WBGT）警戒レベルをバッジ用に返す。
    「ほぼ安全」（21未満）と、提供期間の外で今の時刻の値が得られないときは空（reading=None）。
    提供期間の中で地点解決・取得に失敗したか今の時刻の値が得られなければ502。"""
    enforce_rate_limit(http_request, "weather-wbgt", settings.weather_wbgt_rate_limit_per_minute)
    return _or_502(
        await wbgt_service.get_status(Coordinates(latitude=latitude, longitude=longitude), datetime.now(JST)),
        _BADGE_SOURCE_UNAVAILABLE,
    )


@router.get("/api/weather/flood-forecast", response_model=FloodForecasts)
async def get_flood_forecast(
    http_request: Request,
    latitude: Latitude,
    longitude: Longitude,
    flood_service: FloodService = Depends(get_flood_service),
) -> FloodForecasts:
    """出発地点近傍のJMA指定河川洪水予報（レベル2〜5）をバッジ用に返す。
    地点解決か洪水予報自体の取得に失敗したら502（空の応答は「予報なし」だけを表す）。"""
    enforce_rate_limit(
        http_request, "weather-flood-forecast", settings.weather_flood_forecast_rate_limit_per_minute
    )
    return _or_502(
        await flood_service.get_forecasts(Coordinates(latitude=latitude, longitude=longitude)),
        _BADGE_SOURCE_UNAVAILABLE,
    )


@router.get("/api/weather/amedas", response_model=AmedasObservation)
async def get_amedas(
    http_request: Request,
    latitude: Latitude,
    longitude: Longitude,
    amedas_service: JmaAmedasService = Depends(get_amedas_service),
) -> AmedasObservation:
    """出発地点近傍の最寄りアメダス観測所の直近観測値を返す。
    観測値本体はRedis Hash（TTL 15分）でキャッシュされる（infrastructure/jma_amedas_store.py参照）。
    観測所解決・取得のいずれかに失敗した場合は502を返す。"""
    enforce_rate_limit(http_request, "amedas", settings.weather_amedas_rate_limit_per_minute)
    return _or_502(
        await amedas_service.get_nearest_observation(Coordinates(latitude=latitude, longitude=longitude)),
        "アメダス観測値の取得に失敗しました",
    )
