"""`domain/weather.py`——アメダスの実測と推計気象分布の区分から天気コードを導くことと、最寄りの格子点の時系列から今日の値を組み立てること。

入口は`derive_observed_weather_code`と`grid_point_today`。

ここで見ないもの:
- 観測値と推計気象分布の区分がこの規則へ渡り、応答に出ること → `test_jma_amedas_service.py`
- 最寄りの格子点を選んで読むこと → `test_msm.py`（選び方）・`test_msm_client.py`（読み出し）
- 今日の値が応答に出ること → `test_weather_route.py`
"""

from datetime import datetime
from typing import get_args

import numpy as np
import pytest

from app.domain.geo import LatLonPoint
from app.domain.weather import SuikeiWeather, derive_observed_weather_code, grid_point_today
from app.domain.weather_display import WEATHER_CATEGORIES


@pytest.mark.parametrize(
    ("precipitation_10min", "suikei", "temperature", "expected"),
    [
        (0.0, "clear", 20.0, 0),
        (0.0, "cloudy", 20.0, 3),
        (None, "cloudy", 20.0, 3),
        (0.1, "clear", 20.0, 61),  # 10分0.1mm＝1時間0.6mm相当は弱い雨。空より降水を先に見る
        (1.0, None, 20.0, 65),  # 1時間6mm相当は強い雨
        (0.5, None, 0.0, 73),  # 1時間3mm相当。0℃以下は雪
        (0.5, None, 0.1, 63),
        (0.5, None, None, 63),  # 気温が欠測なら雨
        (0.0, None, 20.0, None),  # 降水なしで空が分からなければ判定材料が無い
    ],
)
def test_derive_observed_weather_code(precipitation_10min, suikei, temperature, expected):
    assert derive_observed_weather_code(precipitation_10min, suikei, temperature) == expected


def test_weather_categories_hold_exactly_the_derived_codes():
    """画面は分類に無いコードを出さないので、導くコードはどれも分類に入る。導かないコードと、導くコードを1つも
    持たない分類は、画面に通らないアイコンを残すので置かない。入力は降水量の全ての強さの帯・空の
    区分・気温の雨と雪の両側を掃く。"""
    precipitations = [None, *(step / 100 for step in range(201))]
    derived = {
        derive_observed_weather_code(precipitation, suikei, temperature)
        for precipitation in precipitations
        for suikei in (None, *get_args(SuikeiWeather))
        for temperature in (None, -5.0, 0.0, 0.1, 20.0)
    } - {None}
    categorized = {code for category in WEATHER_CATEGORIES for code in category.codes}
    assert derived
    assert derived <= categorized, sorted(derived - categorized)
    assert categorized <= derived, sorted(categorized - derived)
    assert all(category.codes for category in WEATHER_CATEGORIES)


def test_today_at_a_grid_point_is_its_hourly_values_until_midnight_with_where_it_lies():
    """日付が変わった後の値は、今日の値にも、最も高い・低い値にも入らない。"""
    nan = float("nan")

    today = grid_point_today(
        LatLonPoint(35.0, 139.0),
        35.0,
        139.0625,
        [datetime(2026, 10, 19, hour) for hour in (21, 22, 23)] + [datetime(2026, 10, 20, 0)],
        temperature_c=np.array([12.34, nan, 15.06, 30.0]),
        precipitation_mm=np.array([nan, nan, nan, 3.0]),
        wind_u_ms=np.array([-3.0, 0.0, 4.0, 30.0]),
        wind_v_ms=np.array([-4.0, 2.0, 0.0, 0.0]),
    )

    assert today.model_dump() == {
        "latitude": 35.0,
        "longitude": 139.0625,
        "distance_km": 5.7,
        "bearing_deg": 90,
        "times": ["2026-10-19T21:00", "2026-10-19T22:00", "2026-10-19T23:00"],
        "temperature_c": [12.3, None, 15.1],
        "precipitation_mm": [None, None, None],
        "wind_speed_ms": [5.0, 2.0, 4.0],
        "wind_direction_deg": [37.0, 180.0, 270.0],
        "highest_hourly_temperature_c": 15.1,
        "lowest_hourly_temperature_c": 12.3,
        "highest_hourly_precipitation_mm": None,
        "highest_hourly_wind_speed_ms": 5.0,
    }
