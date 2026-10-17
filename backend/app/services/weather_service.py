from datetime import datetime

import numpy as np
from cachetools import LRUCache

from app.domain.rain import StationRainMaterials
from app.domain.msm import wind_speed_and_direction
from app.domain.route import Coordinates
from app.domain.twilight import sunrise_sunset_jst
from app.domain.weather import (
    PERIOD_INTERVAL_HOURS, PRECIPITATION_MM_DECIMALS, WIND_DIRECTION_DEG_DECIMALS, WIND_SPEED_MS_DECIMALS,
    WeatherConditions, daily_max, daily_range, period_outlooks, rounded_or_none, rounded_rows, today_indices,
)
from app.domain.region import BoundingBox
from app.domain.wind import (
    DEPARTURE_WIND_DECIMALS, WIND_FORECAST_LAT_STEP_DEG, WIND_FORECAST_LON_STEP_DEG, DepartureWind, WindForecastSeries,
    WindLattice,
)
from app.domain.wind_grid import WindGridPoint, WindGridResponse
from app.infrastructure import msm_client
from app.infrastructure.msm_client import MsmSeries, MsmUnavailableError
from app.services.jma_amedas_service import load_station_rain_materials, new_rain_materials_cache


# 同時に「今日」のパネルを開いている地点の数より大きければよい。1件は数KB。
_CONDITIONS_CACHE_SIZE = 1024
# 粗い格子の全点と、詳細格子の数画面ぶん（1画面の上限は`domain/wind_grid.py: WIND_GRID_DETAIL_MAX_POINTS`）を持てる数。
# 1点が予報の時間ぶんの3系列を持つので、件数が持つメモリの大きさを決める（docs/modules/backend/weather-dynamic-layers.md）。
_GRID_POINT_CACHE_SIZE = 5000


class WeatherService:
    """地点の天候・予報を気象庁MSMから読み、雨の観測の材料をアメダスの履歴から読む。

    現在値として扱うのは常に時系列の先頭（現在時刻の正時）で、任意の時刻は指定できない。
    日の出・日没は外部に問い合わせず`domain/twilight.py`で計算する。
    雨の材料と、予報から組み立てた応答（「今日」のパネル・風の格子の点）は実体の中に持つため、組み立てる側
    （`api/dependencies.py`）が実体をプロセスに1つ持つ。組み立てた応答は予報の版（`msm_client.py: forecast_version`）を
    鍵に持ち、同じ版のあいだは予報のファイルを読み直さない。
    """

    def __init__(self) -> None:
        self._rain_materials_cache = new_rain_materials_cache()
        # 利用者の現在地ごとに1件。版が変わると古い版の鍵は引かれなくなり、件数の上限で追い出される。
        self._conditions_cache: LRUCache = LRUCache(maxsize=_CONDITIONS_CACHE_SIZE)
        # 鍵は(版, 緯度, 経度)。粗い格子と各間隔の詳細格子が同じ点を共有する（どの格子も緯度・経度0度から数えた点に乗る）。
        self._grid_point_cache: LRUCache = LRUCache(maxsize=_GRID_POINT_CACHE_SIZE)
        self._grid_times: tuple[tuple, list[datetime]] | None = None

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

    async def get_conditions(self, point: Coordinates) -> WeatherConditions | None:
        version = msm_client.forecast_version()
        key = (version, point.latitude, point.longitude)
        cached = self._conditions_cache.get(key)
        if cached is not None:
            return cached
        series = await self._read_point(point)
        if series is None:
            return None
        conditions = self._conditions_from_series(point, series)
        if msm_client.forecast_version() == version:
            self._conditions_cache[key] = conditions
        return conditions

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

    async def get_wind_grid(self, points: list[Coordinates]) -> WindGridResponse | None:
        """複数地点の時間別風向・風速・降水量をまとめて取得する。特定時刻1点へ収束させず、
        予報期間ぶんの時系列をそのまま返す。

        同じ版で組み立てた点は使い回し、無い点だけを1回で読む。MSMは全地点を1回で読むため、読めないときは地点ごとでは
        なく格子ごと読めない（None）。
        """
        if not points:
            return WindGridResponse(times=[], points=[])
        version = msm_client.forecast_version()
        if self._grid_times is not None and self._grid_times[0] == version:
            cached = [self._grid_point_cache.get((version, point.latitude, point.longitude)) for point in points]
            missing = [point for point, found in zip(points, cached) if found is None]
            if not missing:
                return WindGridResponse(times=self._grid_times[1], points=cached)
        else:
            cached = [None] * len(points)
            missing = points

        built = await self._build_wind_grid(missing)
        if built is None:
            return None
        times, fresh = built
        if msm_client.forecast_version() != version:
            # 読む間に版が変わった。読んだ点はどの版のものか決まらないので残さず、残っていた点とも混ぜない。
            if len(missing) < len(points):
                built = await self._build_wind_grid(points)
                if built is None:
                    return None
                times, fresh = built
            return WindGridResponse(times=times, points=fresh)
        self._grid_times = (version, times)
        for grid_point in fresh:
            self._grid_point_cache[(version, grid_point.latitude, grid_point.longitude)] = grid_point
        fresh_points = iter(fresh)
        results = [found if found is not None else next(fresh_points) for found in cached]
        return WindGridResponse(times=times, points=results)

    async def _build_wind_grid(self, points: list[Coordinates]) -> tuple[list[datetime], list[WindGridPoint]] | None:
        series = await self._read(
            np.array([point.latitude for point in points], dtype=float),
            np.array([point.longitude for point in points], dtype=float),
        )
        if series is None:
            return None

        speed, direction = wind_speed_and_direction(series.wind_u_ms, series.wind_v_ms)
        # 数万要素をPythonのループで丸めると地点数に比例して重くなるため、配列のまま
        # まとめて丸めてからリストへ変換する。
        speeds = rounded_rows(speed, WIND_SPEED_MS_DECIMALS)
        directions = rounded_rows(direction, WIND_DIRECTION_DEG_DECIMALS)
        precipitations = rounded_rows(series.precipitation_mm, PRECIPITATION_MM_DECIMALS)
        return series.times, [
            WindGridPoint(
                latitude=point.latitude,
                longitude=point.longitude,
                wind_speed_ms=speeds[index],
                wind_direction_deg=directions[index],
                precipitation_mm=precipitations[index],
            )
            for index, point in enumerate(points)
        ]

    def _conditions_from_series(self, point: Coordinates, series: MsmSeries) -> WeatherConditions:
        """MSMの時系列（1地点ぶん）から「今日」のパネル向けの値を組み立てる。時系列の先頭（現在時刻の
        正時）を現在値として扱い、日次の集計は同じJST暦日の残り時間ぶんを対象にする。"""
        times = series.times
        speed, _direction = wind_speed_and_direction(series.wind_u_ms[0], series.wind_v_ms[0])
        temperature = series.temperature_c[0]
        precipitation = series.precipitation_mm[0]
        today = today_indices(times)

        return WeatherConditions(
            precipitation_mm=rounded_or_none(precipitation[0], PRECIPITATION_MM_DECIMALS),
            twilight=sunrise_sunset_jst(point, times[0].date()),
            precipitation_max_mm=daily_max(precipitation, today),
            wind_speed_max_ms=daily_max(speed, today),
            temperature_range=daily_range(temperature, today),
            today_periods=period_outlooks(times, temperature, precipitation),
            today_period_interval_hours=PERIOD_INTERVAL_HOURS,
        )
