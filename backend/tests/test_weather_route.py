"""`api/routers/weather.py`——警報・ルートの警報級の時系列・暑さ指数・洪水予報・アメダス・今日の最寄りの格子点の値・MSMの格子点の経路。

経路ごとに回数制限を通し、MSMの格子点とルートの警報級の時系列の経路はサービスの答えが応答に出ることも見る。ルーターが持つ判断
（取れなかったら502・表示範囲が不正か広すぎたら400）をこの経路から見る。サービスは依存の差し替えで与える。

ここで見ないもの:
- 警報・ルートの警報級の時系列・暑さ指数・洪水予報・アメダスを取って組み立てること → 各サービスのテスト（`test_warning_service.py`・
  `test_warning_timeline_service.py`・`test_wbgt_service.py`・`test_flood_service.py`・`test_jma_amedas_service.py`）
- MSMの格子点を選んで読むこと → `test_msm.py`（間引き・最寄り）・`test_msm_client.py`（読み出し）
- 最寄りの格子点の時系列から今日の値を組み立てること → `test_weather_domain.py`
- 回数制限の窓 → `test_rate_limiter.py`
- Cache-Control の値と、失敗の応答に付けないこと → `test_cache_policy.py`
- 範囲外の緯度経度を断ること（`domain/geo.py: Latitude`・`Longitude` の制約で、FastAPI が422で返す）
"""

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.api.dependencies import (
    get_amedas_service,
    get_flood_service,
    get_warning_service,
    get_warning_timeline_service,
    get_wbgt_service,
    get_weather_service,
)
from app.config import settings
from app.domain.flood_forecast import ActiveFloodForecast
from app.domain.jma_amedas import AmedasObservation, WindDirection
from app.domain.jma_warning import ActiveWarning
from app.domain.msm_grid import MSM_GRID_MAX_AREA_SQ_DEG, MsmGridForecast, MsmGridPointForecast
from app.domain.time_zone import JST
from app.domain.twilight import Twilight
from app.domain.weather import GridPointToday
from app.infrastructure import rate_limiter
from app.main import app
from app.services.flood_service import FloodForecasts
from app.services.warning_service import WeatherWarnings
from app.services.warning_timeline_service import (
    RouteAreaTimeline,
    RouteWarningTimeline,
    TimelineKindLevels,
    TimelineSlotLevel,
)
from app.services.wbgt_service import WbgtReading, WbgtStatus

client = TestClient(app)

POINT = {"latitude": 35.6812, "longitude": 139.7671}
WARNINGS = WeatherWarnings(
    warnings=[ActiveWarning(code="14", name="雷注意報", level="advisory", additions=["竜巻"])],
    valid_area=None,
)
WBGT = WbgtStatus(
    reading=WbgtReading(level="severe_warning", label="厳重警戒", value=30.0), valid_area=None
)
FLOODS = FloodForecasts(
    forecasts=[
        ActiveFloodForecast(
            river_code="830304004400",
            badge_level="severe_warning",
            label="神田川氾濫危険警報",
            condition="レベル４氾濫危険警報（発表）",
        )
    ],
    valid_area=None,
)
AMEDAS = AmedasObservation(
    station_name="東京",
    observed_at=datetime(2026, 8, 29, 12, 0, tzinfo=JST),
    temperature_c=26.5,
    apparent_temperature_c=27.8,
    wind_speed_ms=3.5,
    wind_direction=WindDirection(deg=180.0, label="南"),
    precipitation_10min_mm=0.0,
    twilight=Twilight(sunrise="2026-08-29T05:12:00+09:00", sunset="2026-08-29T18:41:00+09:00"),
    weather_code=0,
    valid_area=None,
)
MSM_GRID = MsmGridForecast(
    times=[datetime(2026, 10, 7, 12, 0)],
    latitude_step_deg=0.05,
    longitude_step_deg=0.0625,
    points=[
        MsmGridPointForecast(
            latitude=35.65, longitude=139.75, wind_speed_ms=[5.5], wind_direction_deg=[270.0], precipitation_mm=[None],
        ),
    ],
)
GRID_POINT_TODAY = GridPointToday(
    latitude=35.7,
    longitude=139.75,
    distance_km=2.1,
    bearing_deg=338,
    times=[datetime(2026, 10, 19, 23, 0)],
    temperature_c=[14.2],
    precipitation_mm=[None],
    wind_speed_ms=[3.1],
    wind_direction_deg=[350.0],
    highest_hourly_temperature_c=14.2,
    lowest_hourly_temperature_c=14.2,
    highest_hourly_precipitation_mm=None,
    highest_hourly_wind_speed_ms=3.1,
)
ROUTE_TIMELINE = RouteWarningTimeline(
    areas=[
        RouteAreaTimeline(
            area_code="1310100",
            area_name="千代田区",
            start_index=0,
            end_index=1,
            kinds={
                "thunder": TimelineKindLevels(
                    advisory_label="雷（注意報級）",
                    slots=[
                        TimelineSlotLevel(
                            start=datetime(2026, 10, 21, 18, 0, tzinfo=JST),
                            end=datetime(2026, 10, 21, 21, 0, tzinfo=JST),
                            code="20",
                            advisory=True,
                        )
                    ],
                    additions=["突風"],
                )
            },
        )
    ]
)
ROUTE_POINTS = {"points": [POINT, {"latitude": 35.69, "longitude": 139.70}]}
#: 東京駅の周りの、ズーム8の地図ほどの範囲。
TOKYO_BBOX = {"min_lon": 139.0, "min_lat": 35.3, "max_lon": 140.4, "max_lat": 36.0}


class FakeService:
    """天気の各サービスの代役。地点を問う口は与えた答えを返す。"""

    def __init__(self, answer=None):
        self._answer = answer

    async def get_warnings(self, point):
        return self._answer

    async def get_status(self, point, now):
        return self._answer

    async def get_forecasts(self, point):
        return self._answer

    async def get_nearest_observation(self, point):
        return self._answer

    async def get_grid_point_today(self, point):
        return self._answer

    async def get_msm_grid(self, bbox):
        return self._answer

    async def get_route_timeline(self, points):
        return self._answer


def test_the_msm_grid_route_returns_the_grid_points_with_local_times(override_dependency):
    override_dependency(get_weather_service, lambda: FakeService(MSM_GRID))

    response = client.get("/api/weather/msm-grid", params=TOKYO_BBOX)

    assert response.status_code == 200
    assert response.json() == {
        "times": ["2026-10-07T12:00"],
        "latitude_step_deg": 0.05,
        "longitude_step_deg": 0.0625,
        "points": [
            {
                "latitude": 35.65,
                "longitude": 139.75,
                "wind_speed_ms": [5.5],
                "wind_direction_deg": [270.0],
                "precipitation_mm": [None],
            },
        ],
    }


#: 面積が上限をわずかに超える正方形の一辺[度]。
_TOO_WIDE_SIDE = MSM_GRID_MAX_AREA_SQ_DEG**0.5 + 0.01


@pytest.mark.parametrize(("bbox", "detail"), [
    ({**TOKYO_BBOX, "min_lat": 36.0, "max_lat": 35.3}, "表示範囲が不正です。"),
    (
        {"min_lon": 130.0, "min_lat": 30.0, "max_lon": 130.0 + _TOO_WIDE_SIDE, "max_lat": 30.0 + _TOO_WIDE_SIDE},
        "表示範囲が広すぎます。ズームインしてください。",
    ),
], ids=["inverted", "too-wide"])
def test_an_msm_grid_range_that_is_inverted_or_too_wide_is_refused(override_dependency, bbox, detail):
    """広すぎる範囲は、間引く前に格子点を丸ごと読む（読む量は範囲の格子点の数に比例する）。"""
    override_dependency(get_weather_service, lambda: FakeService(MSM_GRID))

    response = client.get("/api/weather/msm-grid", params=bbox)

    assert response.status_code == 400
    assert response.json() == {"detail": detail}


@pytest.mark.parametrize(("path", "params", "dependency", "detail"), [
    ("/api/weather/warnings", POINT, get_warning_service, "取得できませんでした。"),
    ("/api/weather/wbgt", POINT, get_wbgt_service, "取得できませんでした。"),
    ("/api/weather/flood-forecast", POINT, get_flood_service, "取得できませんでした。"),
    ("/api/weather/amedas", POINT, get_amedas_service, "アメダス観測値の取得に失敗しました"),
    ("/api/weather", POINT, get_weather_service, "気象データの取得に失敗しました"),
    ("/api/weather/msm-grid", TOKYO_BBOX, get_weather_service, "気象データの取得に失敗しました"),
])
def test_a_source_that_could_not_be_obtained_is_a_failure_not_an_empty_answer(
    override_dependency, path, params, dependency, detail
):
    """空の応答は「出ていない」を表す。取れなかったことを同じ空で返すと、画面は出ていないと見せる。"""
    override_dependency(dependency, lambda: FakeService(None))

    response = client.get(path, params=params)

    assert response.status_code == 502
    assert response.json() == {"detail": detail}


@pytest.mark.parametrize(("path", "params", "dependency", "answer", "key", "limit"), [
    (
        "/api/weather/warnings", POINT, get_warning_service, WARNINGS,
        "weather-warnings", settings.weather_warnings_rate_limit_per_minute,
    ),
    ("/api/weather/wbgt", POINT, get_wbgt_service, WBGT, "weather-wbgt", settings.weather_wbgt_rate_limit_per_minute),
    (
        "/api/weather/flood-forecast", POINT, get_flood_service, FLOODS,
        "weather-flood-forecast", settings.weather_flood_forecast_rate_limit_per_minute,
    ),
    ("/api/weather/amedas", POINT, get_amedas_service, AMEDAS, "amedas", settings.weather_amedas_rate_limit_per_minute),
    ("/api/weather", POINT, get_weather_service, GRID_POINT_TODAY, "weather", settings.weather_rate_limit_per_minute),
    (
        "/api/weather/msm-grid", TOKYO_BBOX, get_weather_service, MSM_GRID,
        "msm-grid", settings.msm_grid_rate_limit_per_minute,
    ),
])
def test_each_route_is_rate_limited_per_client(override_dependency, path, params, dependency, answer, key, limit):
    override_dependency(dependency, lambda: FakeService(answer))
    for _ in range(limit - 1):
        rate_limiter.check_rate_limit(f"{key}:testclient", limit)

    assert client.get(path, params=params).status_code == 200
    assert client.get(path, params=params).status_code == 429


def test_the_route_warning_timeline_route_returns_what_its_source_answered(override_dependency):
    override_dependency(get_warning_timeline_service, lambda: FakeService(ROUTE_TIMELINE))

    response = client.post("/api/weather/route-warning-timeline", json=ROUTE_POINTS)

    assert response.status_code == 200
    assert RouteWarningTimeline.model_validate(response.json()) == ROUTE_TIMELINE


def test_route_warning_timeline_that_could_not_be_obtained_is_a_failure_not_an_empty_answer(override_dependency):
    """空の通過は「ルートがどの区域にも入らない」を表す。取れなかったことを同じ空で返すと、画面は注意報級の時間帯が無いと見せる。"""
    override_dependency(get_warning_timeline_service, lambda: FakeService(None))

    response = client.post("/api/weather/route-warning-timeline", json=ROUTE_POINTS)

    assert response.status_code == 502
    assert response.json() == {"detail": "取得できませんでした。"}


def test_the_route_warning_timeline_route_is_rate_limited_per_client(override_dependency):
    override_dependency(get_warning_timeline_service, lambda: FakeService(ROUTE_TIMELINE))
    limit = settings.weather_warning_timeline_rate_limit_per_minute
    for _ in range(limit - 1):
        rate_limiter.check_rate_limit("weather-warning-timeline:testclient", limit)

    assert client.post("/api/weather/route-warning-timeline", json=ROUTE_POINTS).status_code == 200
    assert client.post("/api/weather/route-warning-timeline", json=ROUTE_POINTS).status_code == 429
