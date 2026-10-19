"""`services/weather_service.py`——MSMの読み出しから、出発時点の風を組み立てる。

MSMの読み出し（`msm_client.read_series`）だけを差し替え、domainの計算は本物を通す。

ここで見ないもの:
- 風の成分から風速・風向を求めること・格子の敷き方 → `test_msm.py`・`test_wind.py`
"""

from datetime import datetime

import numpy as np

from app.domain.route import Coordinates
from app.domain.wind import DepartureWind
from app.infrastructure import msm_client
from app.infrastructure.msm_client import MsmSeries
from app.services.weather_service import WeatherService

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
