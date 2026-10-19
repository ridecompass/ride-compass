"""`api/routers/weather.py`——警報・暑さ指数・洪水予報・アメダスの経路。

経路ごとに受け渡し（サービスの答えが応答に出ること・回数制限）を1本ずつ通し、ルーターが持つ判断（取れなかったら502）を
この経路から見る。サービスは依存の差し替えで与える。

ここで見ないもの:
- 警報・暑さ指数・洪水予報・アメダスを取って組み立てること → 各サービスのテスト（`test_warning_service.py`・
  `test_wbgt_service.py`・`test_flood_service.py`・`test_jma_amedas_service.py`）
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
    get_wbgt_service,
)
from app.config import settings
from app.domain.flood_forecast import ActiveFloodForecast
from app.domain.jma_amedas import AmedasObservation, WindDirection
from app.domain.jma_warning import ActiveWarning
from app.domain.time_zone import JST
from app.domain.twilight import Twilight
from app.infrastructure import rate_limiter
from app.main import app
from app.services.flood_service import FloodForecasts
from app.services.warning_service import WeatherWarnings
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

#: 地点を問う経路と、そのサービスの依存・取れたときの答え。
POINT_ROUTES = [
    ("/api/weather/warnings", get_warning_service, WARNINGS),
    ("/api/weather/wbgt", get_wbgt_service, WBGT),
    ("/api/weather/flood-forecast", get_flood_service, FLOODS),
    ("/api/weather/amedas", get_amedas_service, AMEDAS),
]


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


@pytest.fixture(autouse=True)
def _clear_dependency_overrides():
    """テストが足した依存の差し替えを、抜けるときに片付ける。"""
    yield
    app.dependency_overrides.clear()


@pytest.mark.parametrize(("path", "dependency", "answer"), POINT_ROUTES)
def test_a_point_route_returns_what_its_source_answered(path, dependency, answer):
    app.dependency_overrides[dependency] = lambda: FakeService(answer)

    response = client.get(path, params=POINT)

    assert response.status_code == 200
    assert response.json() == answer.model_dump(mode="json")


@pytest.mark.parametrize(("path", "dependency", "detail"), [
    ("/api/weather/warnings", get_warning_service, "取得できませんでした。"),
    ("/api/weather/wbgt", get_wbgt_service, "取得できませんでした。"),
    ("/api/weather/flood-forecast", get_flood_service, "取得できませんでした。"),
    ("/api/weather/amedas", get_amedas_service, "アメダス観測値の取得に失敗しました"),
])
def test_a_source_that_could_not_be_obtained_is_a_failure_not_an_empty_answer(path, dependency, detail):
    """空の応答は「出ていない」を表す。取れなかったことを同じ空で返すと、画面は出ていないと見せる。"""
    app.dependency_overrides[dependency] = lambda: FakeService(None)

    response = client.get(path, params=POINT)

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
])
def test_each_route_is_rate_limited_per_client(path, params, dependency, answer, key, limit):
    app.dependency_overrides[dependency] = lambda: FakeService(answer)
    for _ in range(limit - 1):
        rate_limiter.check_rate_limit(f"{key}:testclient", limit)

    assert client.get(path, params=params).status_code == 200
    assert client.get(path, params=params).status_code == 429
