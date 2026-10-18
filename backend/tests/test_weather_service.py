"""`services/weather_service.py`——MSMの読み出しから、地点の天候・出発時点の風・風の格子・風の予報の系列を組み立てる。

MSMの読み出し（`msm_client.read_series`）だけを差し替え、domainの計算は本物を通す。「今日」のパネルの
読み方（`domain/weather.py`の今日の範囲・日次の値・コマ）は、ここで入口から見る。

ここで見ないもの:
- 実測から天気コードを導く規則 → `test_weather_domain.py`
- 風の成分から風速・風向を求めること・格子の敷き方 → `test_msm.py`・`test_wind.py`
- 日の出・日没の計算 → `test_twilight.py`
"""

from datetime import datetime

import numpy as np

from app.domain.route import Coordinates
from app.domain.weather import TemperatureRange
from app.domain.wind import DepartureWind
from app.domain.wind_grid import WindGridResponse
from app.infrastructure import msm_client
from app.infrastructure.msm_client import MsmSeries
from app.services.weather_service import WeatherService

POINT = Coordinates(latitude=35.7597, longitude=139.7387)
OTHER_POINT = Coordinates(latitude=35.1, longitude=139.1)


def _series(times, *, u=None, v=None, precipitation=None, temperature=None, count=1):
    """MSMの読み出し結果を、`count`地点とも同じ値で組み立てる。省略した変数は既定値で埋める。"""
    n = len(times)

    def column(values, default):
        return np.tile(np.array(values if values is not None else [default] * n, dtype=float), (count, 1))

    return MsmSeries(
        times=[datetime.fromisoformat(t) for t in times],
        wind_u_ms=column(u, 0.0),
        wind_v_ms=column(v, 0.0),
        precipitation_mm=column(precipitation, 0.0),
        temperature_c=column(temperature, 20.0),
    )


def _patch_read_series(monkeypatch, **values):
    async def read_series(latitudes, longitudes):
        return _series(**values, count=len(latitudes))

    monkeypatch.setattr(msm_client, "read_series", read_series)


async def test_get_conditions_reports_the_first_hour_as_current(monkeypatch):
    _patch_read_series(monkeypatch, times=["2026-09-07T13:00", "2026-09-07T14:00"], precipitation=[0.2, 0.0])

    conditions = await WeatherService().get_conditions(POINT)

    assert conditions.precipitation_mm == 0.2
    assert conditions.twilight.sunrise.startswith("2026-09-07T0")


async def test_the_departure_wind_is_the_first_hour_rounded_to_a_tenth(monkeypatch):
    """経路の計算が全区間へ一様に使う出発時点の風。東西成分だけの風（u=3.04）は西から吹くため270度。"""
    _patch_read_series(monkeypatch, times=["2026-09-07T13:00", "2026-09-07T14:00"], u=[3.04, 9.0], v=[0.0, 0.0])

    assert await WeatherService().get_departure_wind(POINT) == DepartureWind(speed_ms=3.0, direction_deg=270.0)


async def test_today_values_are_rounded_to_the_digits_the_panel_shows(monkeypatch):
    """「今日」のパネルの値の桁。日次の値とコマの気温は小数1桁、コマの降水量は小数2桁へ丸めて配る。"""
    _patch_read_series(
        monkeypatch,
        times=["2026-09-07T13:00", "2026-09-07T14:00"],
        temperature=[23.46, 25.06],
        precipitation=[1.234, 0.0],
        u=[3.96, 0.0],
    )

    conditions = await WeatherService().get_conditions(POINT)

    assert conditions.temperature_range == TemperatureRange(min_c=23.5, max_c=25.1)
    assert conditions.precipitation_max_mm == 1.2
    assert conditions.wind_speed_max_ms == 4.0
    assert (conditions.today_periods[0].temperature_c, conditions.today_periods[0].precipitation_mm) == (23.5, 1.23)


async def test_a_missing_value_is_absent_rather_than_nan(monkeypatch):
    """格子の欠損（NaN）を含む値は無い（None）。NaN のまま組むと、型が約束しない値が欄に入る。"""
    nan = float("nan")
    _patch_read_series(
        monkeypatch, times=["2026-09-07T13:00", "2026-09-07T14:00"],
        precipitation=[nan, 0.0], temperature=[nan, 20.0], u=[nan, 1.0],
    )

    conditions = await WeatherService().get_conditions(POINT)

    assert conditions.precipitation_mm is None
    assert conditions.precipitation_max_mm is None
    assert conditions.wind_speed_max_ms is None
    assert conditions.today_periods[0].temperature_c is None
    assert conditions.today_periods[0].precipitation_mm is None


async def test_get_conditions_builds_two_hourly_periods(monkeypatch):
    times = [f"2026-09-07T{hour:02d}:00" for hour in range(6, 22)]
    _patch_read_series(monkeypatch, times=times, temperature=[20.0 + i for i in range(len(times))])

    conditions = await WeatherService().get_conditions(POINT)

    assert [p.period for p in conditions.today_periods] == [
        "06:00",
        "08:00",
        "10:00",
        "12:00",
        "14:00",
        "16:00",
        "18:00",
        "20:00",
    ]
    assert conditions.today_periods[1].temperature_c == 22.0
    # 画面はこの間隔をコマの並びの見出しに出す。並びの実際の間隔と食い違わない。
    assert conditions.today_period_interval_hours == 2


async def test_a_missing_value_in_the_grid_is_absent_rather_than_nan(monkeypatch):
    """格子の欠損（NaN）の時刻は値が無い（None）。画面はその時刻の点を飛ばす。"""
    nan = float("nan")
    _patch_read_series(monkeypatch, times=["2026-09-07T13:00", "2026-09-07T14:00"], u=[nan, 0.0], v=[nan, -1.0],
                       precipitation=[nan, 0.4])

    point = (await WeatherService().get_wind_grid([POINT])).points[0]

    assert point.wind_speed_ms == [None, 1.0]
    assert point.wind_direction_deg == [None, 0.0]
    assert point.precipitation_mm == [None, 0.4]


async def test_get_wind_grid_returns_empty_for_empty_points():
    assert await WeatherService().get_wind_grid([]) == WindGridResponse(times=[], points=[])


class _Forecast:
    """置き場の予報。`sync`で中身を入れ替え、置き場のチャンクを書き直す（同期と同じく版が変わる）。

    読み出しは`read_series`の代役で、その時点の中身（東西の風`u`）を全地点へ返す。`sync`せずに`u`だけを変えると、
    置き場は同じまま読み出しの結果だけが変わる——2回目の要求が読み直していれば、変えた値が応答に出る。
    """

    def __init__(self, monkeypatch, tmp_path):
        self.directory = tmp_path / "msm"
        monkeypatch.setattr(msm_client, "MSM_DIR", self.directory)
        monkeypatch.setattr(msm_client, "read_series", self._read_series)
        self.u = 1.0
        self.during_read = None
        self._syncs = 0
        self.sync(1.0)

    def sync(self, u: float) -> None:
        self.u = u
        self._syncs += 1
        chunk = self.directory / "wind_u_component_10m" / "chunk_1.om"
        chunk.parent.mkdir(parents=True, exist_ok=True)
        replacement = chunk.with_suffix(".tmp")
        replacement.write_bytes(b"x" * self._syncs)
        replacement.replace(chunk)

    async def _read_series(self, latitudes, longitudes):
        series = _series(times=["2026-01-01T09:00"], u=[self.u], count=len(latitudes))
        if self.during_read is not None:
            self.during_read()
        return series


def _speeds(grid):
    return [point.wind_speed_ms[0] for point in grid.points]


async def test_the_panel_is_built_once_per_synced_forecast(monkeypatch, tmp_path, clock):
    """同じ予報のあいだの2回目は読み直さず、同期で予報が変わると作り直す。"""
    forecast = _Forecast(monkeypatch, tmp_path)
    service = WeatherService()
    first = await service.get_conditions(POINT)

    forecast.u = 5.0
    assert await service.get_conditions(POINT) == first

    forecast.sync(5.0)
    assert (await service.get_conditions(POINT)).wind_speed_max_ms == 5.0


async def test_grid_points_are_built_once_per_synced_forecast_and_shared_between_grids(monkeypatch, tmp_path, clock):
    """同じ予報のあいだ、組み立てた点は粗い格子・詳細格子をまたいで使い回し、無い点だけを読む。"""
    forecast = _Forecast(monkeypatch, tmp_path)
    service = WeatherService()
    assert _speeds(await service.get_wind_grid([POINT, OTHER_POINT])) == [1.0, 1.0]

    forecast.u = 5.0
    third = Coordinates(latitude=35.2, longitude=139.2)
    assert _speeds(await service.get_wind_grid([OTHER_POINT, third])) == [1.0, 5.0]

    forecast.sync(7.0)
    assert _speeds(await service.get_wind_grid([POINT, OTHER_POINT, third])) == [7.0, 7.0, 7.0]


async def test_points_read_while_the_forecast_is_synced_are_not_kept(monkeypatch, tmp_path, clock):
    """読む間に同期が入った点は、どちらの予報の値か決まらない。残すと、次の同期まで混ざった値を配り続ける。"""
    forecast = _Forecast(monkeypatch, tmp_path)
    service = WeatherService()
    await service.get_wind_grid([POINT])
    forecast.during_read = lambda: forecast.sync(7.0)

    assert _speeds(await service.get_wind_grid([POINT, OTHER_POINT])) == [7.0, 7.0]

    forecast.during_read = None
    forecast.u = 9.0
    assert _speeds(await service.get_wind_grid([POINT, OTHER_POINT])) == [9.0, 9.0]
