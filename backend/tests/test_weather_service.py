"""`services/weather_service.py`——MSMの読み出しから、出発時点の風と格子点ごとの時別の予報・地図に描く格子点の風と降水を組み立てる。

MSMの読み出し（`msm_client.read_series`・`msm_client.read_grid_points`・`msm_client.read_grid_block`・`msm_client.read_weather_grid`）だけを差し替え、domainの計算は本物を通す。

ここで見ないもの:
- 風の成分から風速・風向を求めること・格子点の並びの作り方と間引き → `test_msm.py`
- 格子点の時系列から今日の分を切り出し、丸め、最も高い・低い値を選ぶこと → `test_weather_domain.py`
- 格子点ごとの予報を道・区間へ配ること → `test_wind_way_service.py`・`test_leg_costs.py`
"""

from datetime import datetime

import numpy as np

from app.domain.region import BoundingBox
from app.domain.route import Coordinates
from app.domain.wind import DepartureWind
from app.infrastructure import msm_client
from app.infrastructure.msm_client import (
    MsmGridPointSeries,
    MsmGridPointWeatherSeries,
    MsmSeries,
    MsmUnavailableError,
    MsmWeatherGridSeries,
)
from app.services.weather_service import WeatherService
from tests.bound_fake import bound
from tests.msm_grid import MSM_GRID

POINT = Coordinates(latitude=35.7597, longitude=139.7387)
BBOX = BoundingBox(min_latitude=35.6, min_longitude=139.6, max_latitude=35.7, max_longitude=139.7)


def _columns(values, points: int) -> np.ndarray:
    """どの地点にも同じ時系列`values`を並べた、地点×時刻の配列。"""
    return np.tile(np.array(values, dtype=float), (points, 1))


def _patch_read_series(monkeypatch, *, times, u, v):
    async def read_series(latitudes, longitudes):
        return MsmSeries(
            times=[datetime.fromisoformat(t) for t in times],
            wind_u_ms=_columns(u, len(latitudes)),
            wind_v_ms=_columns(v, len(latitudes)),
        )

    monkeypatch.setattr(msm_client, "read_series", bound(msm_client.read_series, read_series))


async def test_the_departure_wind_is_the_first_hour_rounded_to_a_tenth(monkeypatch):
    """経路の計算が全区間へ一様に使う出発時点の風。東西成分だけの風（u=3.04）は西から吹くため270度。"""
    _patch_read_series(monkeypatch, times=["2026-09-07T13:00", "2026-09-07T14:00"], u=[3.04, 9.0], v=[0.0, 0.0])

    assert await WeatherService().get_departure_wind(POINT) == DepartureWind(speed_ms=3.0, direction_deg=270.0)


async def test_the_point_gets_today_at_its_nearest_grid_point(monkeypatch):
    """`/api/weather`の答え。格子点の位置と、その格子点の今日の時刻の値だけが届く。"""
    async def read_grid_points(latitudes, longitudes):
        count = len(latitudes)
        return MsmGridPointWeatherSeries(
            times=[datetime(2026, 10, 7, 23, 0), datetime(2026, 10, 8, 0, 0)],
            points=MSM_GRID.nearest_points(latitudes, longitudes),
            wind_u_ms=_columns([3.04, 9.0], count),
            wind_v_ms=_columns([0.0, 0.0], count),
            precipitation_mm=_columns([1.26, 5.0], count),
            temperature_c=_columns([18.44, 10.0], count),
        )

    monkeypatch.setattr(msm_client, "read_grid_points", bound(msm_client.read_grid_points, read_grid_points))

    today = await WeatherService().get_grid_point_today(POINT)

    assert (today.latitude, today.longitude) == (35.75, 139.75)
    assert today.times == [datetime(2026, 10, 7, 23, 0)]
    assert (today.temperature_c, today.precipitation_mm, today.wind_speed_ms) == ([18.4], [1.3], [3.0])


async def test_the_point_gets_nothing_when_the_forecast_is_unreadable(monkeypatch):
    async def read_grid_points(latitudes, longitudes):
        raise MsmUnavailableError("予報のファイルが無い")

    monkeypatch.setattr(msm_client, "read_grid_points", bound(msm_client.read_grid_points, read_grid_points))

    assert await WeatherService().get_grid_point_today(POINT) is None


def _patch_read_grid_block(monkeypatch, *, times):
    async def read_grid_block(south, west, north, east):
        points = MSM_GRID.block_covering(south, west, north, east).all_points()
        values = np.ones((len(points.points), len(times)))
        return MsmGridPointSeries(
            times=[datetime.fromisoformat(t) for t in times], points=points, wind_u_ms=values, wind_v_ms=values,
        )

    monkeypatch.setattr(msm_client, "read_grid_block", bound(msm_client.read_grid_block, read_grid_block))


async def test_a_forecast_of_a_single_hour_gives_no_hourly_series(monkeypatch):
    """1時間刻みの並びを作れない予報で、ルートの生成と地図の風の配信を落とさない（風の予報が無いものとして扱う）。"""
    _patch_read_grid_block(monkeypatch, times=["2026-09-07T13:00"])

    assert await WeatherService().get_wind_forecast_lattice(BBOX) is None


async def test_the_map_grid_gives_each_grid_point_its_rounded_wind_and_rain_with_missing_values_as_none(monkeypatch):
    """東西成分だけの風（u=3.04）は西から吹くため270度。格子の欠損（NaN）を0と読むと、降っていないと見せる。"""
    async def read_weather_grid(south, west, north, east, max_points):
        points = MSM_GRID.block_overlapping(south, west, north, east).thinned_points(max_points)
        count = len(points.points)
        return MsmWeatherGridSeries(
            times=[datetime(2026, 10, 7, 12, 0)],
            points=points,
            wind_u_ms=np.full((count, 1), 3.04),
            wind_v_ms=np.zeros((count, 1)),
            precipitation_mm=np.array([[1.26], [np.nan]] + [[0.0]] * (count - 2)),
        )

    monkeypatch.setattr(msm_client, "read_weather_grid", bound(msm_client.read_weather_grid, read_weather_grid))

    forecast = await WeatherService().get_msm_grid(BBOX)

    first, second = forecast.points[:2]
    assert (first.latitude, first.longitude) == (35.6, 139.5625)
    assert (first.wind_speed_ms, first.wind_direction_deg, first.precipitation_mm) == ([3.0], [270.0], [1.3])
    assert second.precipitation_mm == [None]
    assert (forecast.latitude_step_deg, forecast.longitude_step_deg) == (0.05, 0.0625)
