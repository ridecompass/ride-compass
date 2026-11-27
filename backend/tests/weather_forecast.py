"""時別の天気の予報（`domain/wind.py: WeatherForecastSeries`）の組み立て。予報を入力に取るテストと、天気の代役
（`tests/route_world.py: Weather`）が使う。

呼び手は始まりの時刻と、格子点ごと・時刻ごとの値だけを渡す。時刻は1時間刻みに並べ、風向と気温は省けば北・標準の気温。
格子は既定で1行に格子点を並べたもので、格子の位置は風の高さの換算（格子点ごとの粗度）に効くため、場所を見るテストは
`lattice`を渡す。
"""

from datetime import datetime, timedelta

import numpy as np
from numpy.typing import ArrayLike

from app.domain.cycling_speed import STANDARD_TEMPERATURE_C
from app.domain.msm import MsmBlock, MsmGrid
from app.domain.wind import WeatherForecastSeries


def weather_forecast(
    start: datetime, speed_ms: ArrayLike, *, direction_deg: ArrayLike = 0.0,
    temperature_c: ArrayLike = STANDARD_TEMPERATURE_C, lattice: MsmBlock | None = None,
) -> WeatherForecastSeries:
    """`start`から1時間刻みの予報。`speed_ms`は「格子点 × 時刻」（1次元なら格子点1つ）。`direction_deg`・`temperature_c`は
    `speed_ms`の形へ広げる。最新のrunの終わりは最後の時刻の1時間後（どの時刻も最新のrunの中）。"""
    speed = np.atleast_2d(np.asarray(speed_ms, dtype=float))
    points, hours = speed.shape
    times = [start + timedelta(hours=hour) for hour in range(hours)]
    if lattice is None:
        lattice = MsmBlock(
            grid=MsmGrid(lat_min=35.0, lon_min=139.0, d_lat=0.05, d_lon=0.0625, n_lat=1, n_lon=points),
            row0=0, col0=0, rows=1, cols=points,
        )
    return WeatherForecastSeries(
        times=times, speed_ms=speed,
        direction_deg=np.broadcast_to(np.asarray(direction_deg, dtype=float), speed.shape).copy(),
        temperature_c=np.broadcast_to(np.asarray(temperature_c, dtype=float), speed.shape).copy(),
        lattice=lattice,
        latest_run_end=times[-1] + timedelta(hours=1),
    )
