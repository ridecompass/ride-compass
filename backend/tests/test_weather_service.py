"""`services/weather_service.py`——MSMの読み出しから、出発時点の風と格子点ごとの時別の予報を組み立てる。

MSMの読み出し（`msm_client.read_series`・`msm_client.read_grid_block`）だけを差し替え、domainの計算は本物を通す。

ここで見ないもの:
- 風の成分から風速・風向を求めること・格子点の並びの作り方 → `test_msm.py`
- 格子点ごとの予報を道・区間へ配ること → `test_wind_way_service.py`・`test_leg_costs.py`
"""

from datetime import datetime

import numpy as np

from app.domain.msm import MsmGrid
from app.domain.region import BoundingBox
from app.domain.route import Coordinates
from app.domain.wind import DepartureWind
from app.infrastructure import msm_client
from app.infrastructure.msm_client import MsmGridPointSeries, MsmSeries
from app.services.weather_service import WeatherService
from tests.bound_fake import bound

POINT = Coordinates(latitude=35.7597, longitude=139.7387)


def _patch_read_series(monkeypatch, *, times, u, v):
    async def read_series(latitudes, longitudes):
        def column(values):
            return np.tile(np.array(values, dtype=float), (len(latitudes), 1))

        return MsmSeries(
            times=[datetime.fromisoformat(t) for t in times], wind_u_ms=column(u), wind_v_ms=column(v),
        )

    monkeypatch.setattr(msm_client, "read_series", read_series)


async def test_the_departure_wind_is_the_first_hour_rounded_to_a_tenth(monkeypatch):
    """経路の計算が全区間へ一様に使う出発時点の風。東西成分だけの風（u=3.04）は西から吹くため270度。"""
    _patch_read_series(monkeypatch, times=["2026-09-07T13:00", "2026-09-07T14:00"], u=[3.04, 9.0], v=[0.0, 0.0])

    assert await WeatherService().get_departure_wind(POINT) == DepartureWind(speed_ms=3.0, direction_deg=270.0)


def _patch_read_grid_block(monkeypatch, *, times):
    grid = MsmGrid.from_bbox_and_shape((22.4, 120.0, 47.6, 150.0), 505, 481)

    async def read_grid_block(south, west, north, east):
        points = grid.block_covering(south, west, north, east).all_points()
        values = np.ones((len(points.points), len(times)))
        return MsmGridPointSeries(
            times=[datetime.fromisoformat(t) for t in times], points=points, wind_u_ms=values, wind_v_ms=values,
        )

    monkeypatch.setattr(msm_client, "read_grid_block", bound(msm_client.read_grid_block, read_grid_block))


async def test_a_forecast_of_a_single_hour_gives_no_hourly_series(monkeypatch):
    """1時間刻みの並びを作れない予報で、ルートの生成と地図の風の配信を落とさない（風の予報が無いものとして扱う）。"""
    _patch_read_grid_block(monkeypatch, times=["2026-09-07T13:00"])
    bbox = BoundingBox(min_latitude=35.6, min_longitude=139.6, max_latitude=35.7, max_longitude=139.7)

    assert await WeatherService().get_wind_forecast_lattice(bbox) is None
