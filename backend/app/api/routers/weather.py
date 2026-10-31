from datetime import datetime
from typing import TypeVar

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError

from app.api.dependencies import (
    get_amedas_service,
    get_flood_service,
    get_warning_service,
    get_warning_timeline_service,
    get_wbgt_service,
    get_weather_service,
)
from app.api.rate_limit import enforce_rate_limit
from app.config import settings
from app.domain.geo import Latitude, Longitude
from app.domain.jma_amedas import AmedasObservation
from app.domain.msm_grid import MSM_GRID_MAX_AREA_SQ_DEG, MsmGridForecast
from app.domain.region import BoundingBox
from app.domain.route import Coordinates
from app.domain.time_zone import JST
from app.domain.weather import GridPointToday
from app.services.flood_service import FloodForecasts, FloodService
from app.services.warning_service import WarningService, WeatherWarnings
from app.services.warning_timeline_service import (
    RouteTimelineRequest,
    RouteWarningTimeline,
    WarningTimelineService,
)
from app.services.wbgt_service import WbgtService, WbgtStatus
from app.services.jma_amedas_service import JmaAmedasService
from app.services.weather_service import WeatherService


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


@router.post("/api/weather/route-warning-timeline", response_model=RouteWarningTimeline)
async def get_route_warning_timeline(
    http_request: Request,
    request: RouteTimelineRequest,
    timeline_service: WarningTimelineService = Depends(get_warning_timeline_service),
) -> RouteWarningTimeline:
    """ルートが通る区域ごとに、気象庁の警報級の時系列の段をコマのまま返す。区域か段を引けなければ502。"""
    enforce_rate_limit(
        http_request, "weather-warning-timeline", settings.weather_warning_timeline_rate_limit_per_minute
    )
    return _or_502(await timeline_service.get_route_timeline(request.points), _BADGE_SOURCE_UNAVAILABLE)


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
    enforce_rate_limit(http_request, "weather-flood-forecast", settings.weather_flood_forecast_rate_limit_per_minute)
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
    観測所解決・取得のいずれかに失敗した場合は502を返す。"""
    enforce_rate_limit(http_request, "amedas", settings.weather_amedas_rate_limit_per_minute)
    return _or_502(
        await amedas_service.get_nearest_observation(Coordinates(latitude=latitude, longitude=longitude)),
        "アメダス観測値の取得に失敗しました",
    )


@router.get("/api/weather", response_model=GridPointToday)
async def get_weather(
    http_request: Request,
    latitude: Latitude,
    longitude: Longitude,
    weather_service: WeatherService = Depends(get_weather_service),
) -> GridPointToday:
    """地点に最も近い数値予報モデル（MSM）の格子点の、今日の1時間ごとの気温・降水量・風（格子点の値のまま）と、その格子点の
    位置・地点からの距離と方位。MSMを読めないか、地点が格子の外なら502。"""
    enforce_rate_limit(http_request, "weather", settings.weather_rate_limit_per_minute)
    return _or_502(
        await weather_service.get_grid_point_today(Coordinates(latitude=latitude, longitude=longitude)),
        "気象データの取得に失敗しました",
    )


@router.get("/api/weather/msm-grid", response_model=MsmGridForecast)
async def get_msm_grid(
    http_request: Request,
    min_lon: Longitude,
    min_lat: Latitude,
    max_lon: Longitude,
    max_lat: Latitude,
    weather_service: WeatherService = Depends(get_weather_service),
) -> MsmGridForecast:
    """表示範囲の中の、数値予報モデル（MSM）の格子点ごとの時別の風・降水（格子点の値のまま）。格子点が多ければ、格子の原点から
    数えて同じ間隔おきの格子点だけを返す。範囲が不正か広すぎれば400、MSMを読めなければ502。"""
    enforce_rate_limit(http_request, "msm-grid", settings.msm_grid_rate_limit_per_minute)
    try:
        bbox = BoundingBox(min_latitude=min_lat, min_longitude=min_lon, max_latitude=max_lat, max_longitude=max_lon)
    except ValidationError:
        raise HTTPException(status_code=400, detail="表示範囲が不正です。") from None
    if (max_lat - min_lat) * (max_lon - min_lon) > MSM_GRID_MAX_AREA_SQ_DEG:
        raise HTTPException(status_code=400, detail="表示範囲が広すぎます。ズームインしてください。")
    return _or_502(await weather_service.get_msm_grid(bbox), "気象データの取得に失敗しました")
