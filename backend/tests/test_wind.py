"""`domain/wind.py`——風を走行の負荷へ写す式、格子点ごとの時別の予報、通過予定時刻の推定。

入口は`wind_drag_ratio`・`WindForecastSeries`・`estimate_passage_hours`と、
地図へ配る木`WIND_DRAG_RATIO_WAY_FORMULA`。

ここで見ないもの:
- 予報を引くMSMの格子点の並び（`MsmBlock`） → `test_msm.py`
- 風の材料を道・区間へ配る評価器（`domain/dynamic_materials.py`） → `test_wind_way_service.py`・`test_leg_costs.py`
- タイルの道へ予報を引く配信 → `test_wind_way_service.py`
- 探索の時刻ビンと区間の風（`SegmentWind`） → `test_leg_costs.py`・`test_route_generation_behavior.py`
"""

import dataclasses
import math
from datetime import datetime, timedelta

import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain.geo import EARTH_RADIUS_KM
from app.domain.msm import MsmBlock, MsmGrid
from app.domain.route import Coordinates
from app.domain.way_value_formula import way_values_from_formula
from app.domain.wind import (
    WIND_DIRECTION_LEAF,
    WIND_DRAG_RATIO_WAY_FORMULA,
    WIND_SPEED_LEAF,
    WindForecastSeries,
    estimate_passage_hours,
    kmh_to_ms,
    wind_drag_ratio,
)

#: 風速・走行速度の本番の範囲（m/s）。台風の暴風と、想定速度の上限60km/hを覆う。
WIND_SPEEDS = st.floats(0.0, 40.0)
TRAVEL_SPEEDS = st.floats(1.0, 17.0)
BEARINGS = st.floats(0.0, 360.0)


# --- 風の追加負荷 ---


@given(st.floats(0.1, 40.0), TRAVEL_SPEEDS)
def test_a_pure_crosswind_adds_a_little_drag(speed, travel_speed):
    """真横の風も相対風速を増やすので、負荷は正になる。"""
    assert wind_drag_ratio(speed, 90.0, 0.0, travel_speed) > 0.0


@given(WIND_SPEEDS, BEARINGS, BEARINGS, st.floats(5.0, 60.0))
def test_the_map_formula_gives_the_drag_the_route_uses(speed, direction, bearing, speed_kmh):
    """地図の道の色（配る木を道ごとの風と要求の走行方位・想定速度で評価した値）が、ルートの区間の負荷と食い違わない。"""
    values = way_values_from_formula(
        WIND_DRAG_RATIO_WAY_FORMULA, ["way"], {WIND_SPEED_LEAF: [speed], WIND_DIRECTION_LEAF: [direction]},
        {"bearing_deg": bearing, "speed_kmh": speed_kmh})

    assert values == {"way": round(wind_drag_ratio(speed, direction, bearing, kmh_to_ms(speed_kmh)), 3)}


def test_drag_requires_a_positive_travel_speed():
    with pytest.raises(ValueError):
        wind_drag_ratio(3.0, 0.0, 0.0, 0.0)


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
    times, _ = _series().sampled_times(T0 + timedelta(minutes=minutes), np.zeros(1))

    assert times == [T0 + timedelta(hours=hours)]


def test_sample_extends_the_edge_hours_beyond_the_series():
    """探索では値が無いより端の値の方が妥当。延ばしたことは`sampled_times`が示す。"""
    series = _series()

    speed, _ = series.sample(T0, np.array([-5.0, 10.0]), np.array([1, 1]))
    times, clamped = series.sampled_times(T0, np.array([-5.0, 1.0, 10.0]))

    assert speed.tolist() == [100.0, 102.0]
    assert times == [T0, T0 + timedelta(hours=1), T0 + timedelta(hours=2)]
    assert clamped.tolist() == [True, False, True]


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
