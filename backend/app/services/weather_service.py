from datetime import datetime

import numpy as np

from app.domain.rain import StationRainMaterials
from app.domain.msm import wind_speed_and_direction
from app.domain.route import Coordinates
from app.domain.region import BoundingBox
from app.domain.wind import (
    DEPARTURE_WIND_DECIMALS, WIND_FORECAST_LAT_STEP_DEG, WIND_FORECAST_LON_STEP_DEG, DepartureWind, WindForecastSeries,
    WindLattice,
)
from app.infrastructure import msm_client
from app.infrastructure.msm_client import MsmSeries, MsmUnavailableError
from app.services.jma_amedas_service import load_station_rain_materials, new_rain_materials_cache


class WeatherService:
    """風の予報を気象庁MSMから読み、雨の観測の材料をアメダスの履歴から読む。

    雨の材料は実体の中に持つため、組み立てる側（`api/dependencies.py`）が実体をプロセスに1つ持つ。
    """

    def __init__(self) -> None:
        self._rain_materials_cache = new_rain_materials_cache()

    async def get_station_rain_materials(self, now: datetime) -> StationRainMaterials | None:
        """観測所ごとの雨の材料（`jma_amedas_service.py: load_station_rain_materials`）。地図の雨とルートの雨が同じ値を読む。"""
        return await load_station_rain_materials(now, self._rain_materials_cache)

    async def _read(self, latitudes: np.ndarray, longitudes: np.ndarray) -> MsmSeries | None:
        """地点ごとのMSMの時系列。読めないか、時刻が1つも無ければNone。"""
        try:
            series = await msm_client.read_series(latitudes, longitudes)
        except MsmUnavailableError:
            return None
        return series if series.times else None

    async def _read_point(self, point: Coordinates) -> MsmSeries | None:
        return await self._read(np.array([point.latitude], dtype=float), np.array([point.longitude], dtype=float))

    async def get_departure_wind(self, point: Coordinates) -> DepartureWind | None:
        """地点の時系列の先頭（現在時刻の正時）の風。`RoadGraphEngine`が時別の系列の代わりに使う。読めなければNone。"""
        series = await self._read_point(point)
        if series is None:
            return None
        speed, direction = wind_speed_and_direction(series.wind_u_ms[0], series.wind_v_ms[0])
        return DepartureWind(
            speed_ms=round(float(speed[0]), DEPARTURE_WIND_DECIMALS),
            direction_deg=round(float(direction[0]), DEPARTURE_WIND_DECIMALS),
        )

    async def get_wind_forecast_lattice(self, bbox: BoundingBox) -> WindForecastSeries | None:
        """`bbox`を覆う格子点ごとの時別風向・風速の予報系列（1時間刻み、JSTのローカル時刻）。
        読めなければNone。ルートの探索範囲にも、ルートを出す前の地図のタイルにも使う。

        MSMのローカルファイルから読むため外部APIリクエストは発生しない。
        """
        lattice = WindLattice.covering(
            bbox.min_latitude, bbox.min_longitude, bbox.max_latitude, bbox.max_longitude,
            WIND_FORECAST_LAT_STEP_DEG, WIND_FORECAST_LON_STEP_DEG,
        )
        series = await self._read(*lattice.coordinates())
        if series is None:
            return None
        speed, direction = wind_speed_and_direction(series.wind_u_ms, series.wind_v_ms)
        return WindForecastSeries(
            times=series.times,
            speed_ms=speed,
            direction_deg=direction,
            lattice=lattice,
        )
