from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Literal

import numpy as np
from pydantic import PlainSerializer

from app.domain.geo import LatLon, LatLonPoint, bearing_between, compass_degrees, haversine_distance_km
from app.domain.msm import wind_speed_and_direction
from app.domain.msm_grid import (
    PRECIPITATION_MM_DECIMALS,
    TEMPERATURE_C_DECIMALS,
    WIND_DIRECTION_DEG_DECIMALS,
    WIND_SPEED_MS_DECIMALS,
    rounded_coordinates,
    rounded_rows,
)
from app.domain.strict_model import StrictModel
from app.domain.time_zone import jst_local_text

# 天気コードは観測（アメダスと推計気象分布）からだけ導く。数値予報モデル（MSM）の値から天気を計算して出すことは、
# 気象業務法の予報業務の許可の対象と気象庁の公式の説明が書いているため、しない（docs/architecture/data-sources.md
# 「気象業務法の予報業務許可」節）。
#: これ未満（mm/h）は「降っていない」。
PRECIPITATION_MIN_MM = 0.1
_PRECIPITATION_MODERATE_MM = 1.0
_PRECIPITATION_HEAVY_MM = 4.0
_SNOW_MAX_TEMPERATURE_C = 0.0

#: 推計気象分布（天気）の区分。
SuikeiWeather = Literal["clear", "cloudy", "rain", "rain_or_snow", "snow"]


def derive_observed_weather_code(
    precipitation_10min_mm: float | None, suikei: SuikeiWeather | None, temperature_c: float | None
) -> int | None:
    """アメダスの10分間の実測（降水量・気温）と推計気象分布の区分から WMO天気コードを求める。

    降水があれば10分間量を1時間あたりへ直し、気温で雨（61/63/65）と雪（71/73/75）を、1時間あたりの量で
    強さを分ける。降水が無ければ推計の区分で晴れ（0）/くもり（3）に分け、雨・雪の区分もくもりに数える
    ——降っているかは観測所の実測が決め、推計から読むのは降っていないときの空だけ。日照時間は夜は空によらず0になるため
    晴れ・くもりの材料にしない。霧・雷雨はどちらの項目からも判定できないため返さない。降っておらず空も
    分からなければNone。
    """
    hourly_mm = None if precipitation_10min_mm is None else precipitation_10min_mm * 6
    if hourly_mm is not None and hourly_mm >= PRECIPITATION_MIN_MM:
        snow = temperature_c is not None and temperature_c <= _SNOW_MAX_TEMPERATURE_C
        if hourly_mm < _PRECIPITATION_MODERATE_MM:
            return 71 if snow else 61
        if hourly_mm < _PRECIPITATION_HEAVY_MM:
            return 73 if snow else 63
        return 75 if snow else 65
    if suikei is None:
        return None
    return 0 if suikei == "clear" else 3


_DISTANCE_KM_DECIMALS = 1


class GridPointToday(StrictModel):
    """地点に最も近いMSMの格子点の、今日の1時間ごとの値（`GET /api/weather`）。

    値は格子点の値のままで、地点へ補間しない。最も高い・低い値は、並べた1時間ごとの値から
    選んだもので、日の最高・最低気温ではない。時刻の配列と値の配列の並びは揃う。
    """

    #: 格子点の位置。
    latitude: float
    longitude: float
    #: 地点から格子点までの距離[km]。
    distance_km: float
    #: 地点から格子点を見た方位（北=0、東=90）。
    bearing_deg: int
    #: 今の正時から今日の終わりまでの正時。JSTのローカル時刻を分までのISO文字列（タイムゾーン指定なし）で出す。
    times: list[Annotated[datetime, PlainSerializer(jst_local_text, return_type=str)]]
    temperature_c: list[float | None]
    #: その時刻までの1時間の降水量。
    precipitation_mm: list[float | None]
    wind_speed_ms: list[float | None]
    #: 風が吹いてくる方位（北=0、東=90）。
    wind_direction_deg: list[float | None]
    #: 1時間ごとの気温の中で最も高い値・最も低い値。
    highest_hourly_temperature_c: float | None
    lowest_hourly_temperature_c: float | None
    #: 1時間ごとの降水量の中で最も多い値。
    highest_hourly_precipitation_mm: float | None
    #: 1時間ごとの風速の中で最も強い値。
    highest_hourly_wind_speed_ms: float | None


def _rounded(values: np.ndarray, digits: int) -> list[float | None]:
    return rounded_rows(np.asarray(values, dtype=float)[np.newaxis, :], digits)[0]


def _extreme(values: list[float | None], pick: Callable[[list[float]], float]) -> float | None:
    present = [value for value in values if value is not None]
    return pick(present) if present else None


def grid_point_today(
    location: LatLon,
    grid_latitude: float,
    grid_longitude: float,
    times: list[datetime],
    temperature_c: np.ndarray,
    precipitation_mm: np.ndarray,
    wind_u_ms: np.ndarray,
    wind_v_ms: np.ndarray,
) -> GridPointToday:
    """格子点1つの時系列（値の配列は`times`の並び）から、先頭の時刻と同じ日付の時刻を今日として切り出す。"""
    hours = sum(1 for time in times if time.date() == times[0].date())
    speed, direction = wind_speed_and_direction(wind_u_ms[:hours], wind_v_ms[:hours])
    temperature = _rounded(temperature_c[:hours], TEMPERATURE_C_DECIMALS)
    precipitation = _rounded(precipitation_mm[:hours], PRECIPITATION_MM_DECIMALS)
    wind_speed = _rounded(speed, WIND_SPEED_MS_DECIMALS)
    grid_point = LatLonPoint(grid_latitude, grid_longitude)
    latitude, longitude = rounded_coordinates(np.array([grid_latitude, grid_longitude]))
    return GridPointToday(
        latitude=latitude,
        longitude=longitude,
        distance_km=round(haversine_distance_km(location, grid_point), _DISTANCE_KM_DECIMALS),
        bearing_deg=compass_degrees(bearing_between(location, grid_point)),
        times=times[:hours],
        temperature_c=temperature,
        precipitation_mm=precipitation,
        wind_speed_ms=wind_speed,
        wind_direction_deg=_rounded(direction, WIND_DIRECTION_DEG_DECIMALS),
        highest_hourly_temperature_c=_extreme(temperature, max),
        lowest_hourly_temperature_c=_extreme(temperature, min),
        highest_hourly_precipitation_mm=_extreme(precipitation, max),
        highest_hourly_wind_speed_ms=_extreme(wind_speed, max),
    )
