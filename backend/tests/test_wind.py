"""`domain/wind.py`——格子点ごとの時別の予報、通過予定時刻の推定。

入口は`WindForecastSeries`・`estimate_passage_hours`。

ここで見ないもの:
- 予報を引くMSMの格子点の並び（`MsmBlock`） → `test_msm.py`
- 風で増える空気抵抗が走る速さを落とすこと（`drag_increases_m2_s2`） → `test_cycling_speed.py`
- 探索の時刻ビン → `test_leg_costs.py`・`test_route_generation_behavior.py`
"""

import dataclasses
import math
from datetime import datetime, timedelta

import numpy as np
import pytest
from hypothesis import strategies as st

from app.domain.geo import EARTH_RADIUS_KM
from app.domain.msm import MsmBlock, MsmGrid
from app.domain.route import Coordinates
from app.domain.wind import (
    WindForecastSeries,
    estimate_passage_hours,
)

#: 風速・走行速度の本番の範囲（m/s）。台風の暴風と、想定速度の上限60km/hを覆う。
WIND_SPEEDS = st.floats(0.0, 40.0)
TRAVEL_SPEEDS = st.floats(1.0, 17.0)
BEARINGS = st.floats(0.0, 360.0)


# --- 時別の予報 ---

T0 = datetime(2026, 7, 1, 9, 0)


def _series() -> WindForecastSeries:
    """格子点2つ・3時刻。風速は「点の番号×100＋時刻の番号」、風向は時刻の番号×10。"""
    hours = 3
    lattice = MsmBlock(
        grid=MsmGrid(lat_min=35.0, lon_min=139.0, d_lat=1.0, d_lon=1.0, n_lat=2, n_lon=2), row0=0, col0=0, rows=1, cols=2,
    )
    points = lattice.size
    speed = np.array([[p * 100.0 + t for t in range(hours)] for p in range(points)])
    direction = np.array([[t * 10.0 for t in range(hours)] for _ in range(points)])
    return WindForecastSeries(
        times=[T0 + timedelta(hours=t) for t in range(hours)], speed_ms=speed, direction_deg=direction, lattice=lattice
    )


@pytest.mark.parametrize(
    "broken",
    [
        {"times": [T0]},
        {"speed_ms": np.zeros((2, 2))},
        {"direction_deg": np.zeros((1, 3))},
        {"times": [T0, T0 + timedelta(hours=3), T0 + timedelta(hours=6)]},
    ],
    ids=["時刻が1つ", "風速の形が違う", "風向の形が違う", "1時間刻みでない"],
)
def test_a_series_refuses_values_that_do_not_line_up_with_hourly_times_and_points(broken):
    series = _series()

    with pytest.raises(ValueError):
        dataclasses.replace(series, **broken)


def test_sample_picks_the_nearest_hour_for_each_point():
    series = _series()

    speed, direction = series.sample(T0 + timedelta(hours=1), np.array([-0.4, 0.6, 0.0]), np.array([0, 1, 1]))

    assert speed.tolist() == [1.0, 102.0, 101.0]
    assert direction.tolist() == [10.0, 20.0, 10.0]



@pytest.mark.parametrize(("minutes", "hours"), [(30, 1), (90, 2)])
def test_a_passage_halfway_between_two_hours_takes_the_later_one(minutes, hours):
    """毎時30分の通過は、どの時刻でも後の時刻の予報を引く（偶数丸めだと、30分ずつずれた出発が同じ時刻の風になる）。"""
    speed, _ = _series().sample(T0 + timedelta(minutes=minutes), np.zeros(1), np.array([0]))

    # 風速は時刻の番号（点0）。
    assert speed.tolist() == [float(hours)]


def test_sample_extends_the_edge_hours_beyond_the_series():
    """探索では値が無いより端の値の方が妥当。"""
    speed, _ = _series().sample(T0, np.array([-5.0, 10.0]), np.array([1, 1]))

    assert speed.tolist() == [100.0, 102.0]


# --- 通過予定時刻 ---

ANCHOR = Coordinates(latitude=35.0, longitude=139.0)
#: 緯度1度の大円の長さ（km）。
KM_PER_DEGREE = 2 * math.pi * EARTH_RADIUS_KM / 360


@pytest.mark.parametrize(("direction", "expected"), [(1, 5.0), (-1, 1.0)], ids=["離れていく", "向かっていく"])
def test_passage_hours_move_from_the_offset_by_the_detoured_ride_time(direction, expected):
    """基準点から北へ緯度1度の道と基準点そのもの。緯度1度を1時間で進む速さ・迂回率2で、道までは2時間。"""
    hours = estimate_passage_hours(
        np.array([36.0, 35.0]), np.array([139.0, 139.0]), ANCHOR, 3.0, direction, KM_PER_DEGREE, 2.0
    )

    assert hours.tolist() == pytest.approx([expected, 3.0], rel=1e-4)


def test_passage_hours_require_a_positive_speed():
    with pytest.raises(ValueError):
        estimate_passage_hours(np.array([35.0]), np.array([139.0]), ANCHOR, 0.0, 1, 0.0, 1.3)
