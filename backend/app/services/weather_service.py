import numpy as np

from app.domain.msm import wind_speed_and_direction
from app.domain.msm_grid import (
    MSM_GRID_MAX_POINTS,
    PRECIPITATION_MM_DECIMALS,
    WIND_DIRECTION_DEG_DECIMALS,
    WIND_SPEED_MS_DECIMALS,
    MsmGridForecast,
    MsmGridPointForecast,
    rounded_coordinates,
    within_msm_grid_area,
    rounded_rows,
)
from app.domain.route import Coordinates
from app.domain.region import BoundingBox
from app.domain.weather import GridPointToday, grid_point_today
from app.domain.wind import ForecastTimes, WeatherForecastSeries
from app.infrastructure import msm_client
from app.infrastructure.msm_client import MsmUnavailableError


class WeatherService:
    """天気の予報を気象庁MSMから読む。"""

    def forecast_version(self) -> str:
        """置き場の予報の版（同期が予報を入れ替えると変わる）。"""
        return msm_client.forecast_version()

    async def get_forecast_times(self, version: str) -> ForecastTimes | None:
        """予報の版が`version`のままの間に読んだ、今の正時から読める予報の時刻（系列の時刻の形）と最新のrunの予報の終わり。
        読む間に同期が予報を入れ替えたらNone（版と時刻の並びが別の予報になる）。読めなければ投げる。"""
        forecast = await msm_client.forecast_times()
        return forecast if msm_client.forecast_version() == version else None

    async def get_grid_point_today(self, point: Coordinates) -> GridPointToday:
        """`point`に最も近いMSMの格子点の、今日の1時間ごとの値（格子点の値のまま）。読めなければ投げる。"""
        series = await msm_client.read_grid_points(
            np.array([point.latitude], dtype=float), np.array([point.longitude], dtype=float),
        )
        latitudes, longitudes = series.points.coordinates()
        return grid_point_today(
            point,
            float(latitudes[0]),
            float(longitudes[0]),
            series.times,
            series.temperature_c[0],
            series.precipitation_mm[0],
            series.wind_u_ms[0],
            series.wind_v_ms[0],
            series.latest_run_end,
        )

    async def get_msm_grid(self, bbox: BoundingBox) -> MsmGridForecast | None:
        """`bbox`の中のMSMの格子点（点の数が多ければ間引く）ごとの、時別の風と降水（格子点の値のまま）。読めなければ投げる。
        `bbox`が1回に読む広さの上限を超えれば、読まずにNone（読む量は、間引く前の矩形の中の格子点の数に比例する）。"""
        if not within_msm_grid_area(bbox):
            return None
        series = await msm_client.read_weather_grid(
            bbox.min_latitude, bbox.min_longitude, bbox.max_latitude, bbox.max_longitude, MSM_GRID_MAX_POINTS,
        )
        speed, direction = wind_speed_and_direction(series.wind_u_ms, series.wind_v_ms)
        latitudes, longitudes = series.points.coordinates()
        latitude_step, longitude_step = series.points.step_deg
        return MsmGridForecast(
            times=series.times,
            latitude_step_deg=latitude_step,
            longitude_step_deg=longitude_step,
            points=[
                MsmGridPointForecast(
                    latitude=latitude,
                    longitude=longitude,
                    wind_speed_ms=wind_speed,
                    wind_direction_deg=wind_direction,
                    precipitation_mm=precipitation,
                )
                for latitude, longitude, wind_speed, wind_direction, precipitation in zip(
                    rounded_coordinates(latitudes),
                    rounded_coordinates(longitudes),
                    rounded_rows(speed, WIND_SPEED_MS_DECIMALS),
                    rounded_rows(direction, WIND_DIRECTION_DEG_DECIMALS),
                    rounded_rows(series.precipitation_mm, PRECIPITATION_MM_DECIMALS),
                    strict=True,
                )
            ],
            latest_run_end=series.latest_run_end,
        )

    async def get_weather_forecast_lattice(self, bbox: BoundingBox) -> WeatherForecastSeries:
        """`bbox`を覆うMSMの格子点ごとの時別風向・風速・気温の予報系列（1時間刻み、JSTのローカル時刻、格子点の値のまま）。
        読めない・時刻が2つに満たなければ投げる。ルートの探索範囲にも、ルートを出す前の地図のタイルにも使う。

        格子点はMSMの格子そのもの（`domain/msm.py: MsmGrid.block_covering`）なので、ルートの区間と地図の道は、同じ地点で
        同じ格子点の値を引く。MSMのローカルファイルから読むため外部APIリクエストは発生しない。
        """
        series = await msm_client.read_grid_block(
            bbox.min_latitude, bbox.min_longitude, bbox.max_latitude, bbox.max_longitude,
        )
        if len(series.times) < 2:
            raise MsmUnavailableError(f"MSMの天気の予報の時刻が足りません: {len(series.times)}件")
        speed, direction = wind_speed_and_direction(series.wind_u_ms, series.wind_v_ms)
        return WeatherForecastSeries(
            times=series.times,
            speed_ms=speed,
            direction_deg=direction,
            temperature_c=series.temperature_c,
            lattice=series.points.block,
            latest_run_end=series.latest_run_end,
        )
