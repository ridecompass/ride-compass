from datetime import datetime

import numpy as np

from app.domain.rain import StationRainMaterials
from app.domain.msm import wind_speed_and_direction
from app.domain.route import Coordinates
from app.domain.region import BoundingBox
from app.domain.wind import DEPARTURE_WIND_DECIMALS, DepartureWind, WindForecastSeries
from app.infrastructure import msm_client
from app.infrastructure.msm_client import MsmUnavailableError
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

    async def get_departure_wind(self, point: Coordinates) -> DepartureWind | None:
        """地点へ補間した時系列の先頭（現在時刻の正時）の風。`RoadGraphEngine`が時別の系列の代わりに、画面に出さない
        計算にだけ使う。読めなければNone。"""
        try:
            series = await msm_client.read_series(
                np.array([point.latitude], dtype=float), np.array([point.longitude], dtype=float),
            )
        except MsmUnavailableError:
            return None
        if not series.times:
            return None
        speed, direction = wind_speed_and_direction(series.wind_u_ms[0], series.wind_v_ms[0])
        return DepartureWind(
            speed_ms=round(float(speed[0]), DEPARTURE_WIND_DECIMALS),
            direction_deg=round(float(direction[0]), DEPARTURE_WIND_DECIMALS),
        )

    async def get_wind_forecast_lattice(self, bbox: BoundingBox) -> WindForecastSeries | None:
        """`bbox`を覆うMSMの格子点ごとの時別風向・風速の予報系列（1時間刻み、JSTのローカル時刻、格子点の値のまま）。
        読めなければNone。ルートの探索範囲にも、ルートを出す前の地図のタイルにも使う。

        格子点はMSMの格子そのもの（`domain/msm.py: MsmGrid.block_covering`）なので、ルートの区間と地図の道は、同じ地点で
        同じ格子点の値を引く。MSMのローカルファイルから読むため外部APIリクエストは発生しない。
        """
        try:
            series = await msm_client.read_grid_block(
                bbox.min_latitude, bbox.min_longitude, bbox.max_latitude, bbox.max_longitude,
            )
        except MsmUnavailableError:
            return None
        if len(series.times) < 2:
            return None
        speed, direction = wind_speed_and_direction(series.wind_u_ms, series.wind_v_ms)
        return WindForecastSeries(
            times=series.times,
            speed_ms=speed,
            direction_deg=direction,
            lattice=series.points.block,
        )
