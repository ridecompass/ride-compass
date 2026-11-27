"""`domain/geo.py`——方位とその呼び名と、地点の最寄りの点。

入口は`compass_label`・`compass_degrees`・`bearing_between_array`・`nearest_point_index`。方位が別の道で求めた向きと合うこと・
最寄りが本当に最も近いことはhypothesisで任意の地点について確かめ、方位の呼び名は区分の表で確かめる。

ここで見ないもの:
- 方位の呼び名と距離を画面の計算と揃えること → 生成物`geo-expectations.json`を通す画面のテスト
- 最寄りの点を雨・アメダス・暑さ指数の値へ使うこと → それぞれのサービスのテスト
"""

from typing import NamedTuple

import numpy as np
import pytest
from hypothesis import example, given
from hypothesis import strategies as st

from app.domain import geo


class Point(NamedTuple):
    latitude: float
    longitude: float


latitudes = st.floats(min_value=-89.0, max_value=89.0)
longitudes = st.floats(min_value=-180.0, max_value=180.0)
points = st.builds(Point, latitude=latitudes, longitude=longitudes)


# --- compass_label ---


@pytest.mark.parametrize(
    ("bearing", "label"),
    [
        (90.0, "東"),
        (22.4, "北"),
        (22.5, "北東"),  # 区分の境界ちょうどは上の区分へ倒す
        (337.5, "北"),
        (360.0, "北"),
    ],
)
def test_compass_label_names_the_eight_point_sector(bearing, label):
    assert geo.compass_label(bearing) == label


@pytest.mark.parametrize(("bearing", "degrees"), [(0.5, 1), (2.5, 3)])
def test_compass_degrees_rounds_a_half_degree_up_like_the_sector(bearing, degrees):
    """ちょうど半端の度は、区分（`compass_label`）と同じく上へ倒す。偶数丸めだと、応答の度が値の偶奇で前後に倒れる。"""
    assert geo.compass_degrees(bearing) == degrees


# --- bearing_between ---


def tangent_plane_direction(origin: Point, destination: Point) -> tuple[float, float]:
    """方位を球面三角法の式とは別の道で求める: 目的地の位置ベクトルを、出発地で地面に接する平面の北向き・東向きの
    単位ベクトルへ射影した成分（北, 東）。長さは2点の中心角の正弦で、向きが定まらない出発地・対蹠点の近くでは0へ縮む。"""
    lat, lon = np.radians(origin.latitude), np.radians(origin.longitude)
    north = np.array([-np.sin(lat) * np.cos(lon), -np.sin(lat) * np.sin(lon), np.cos(lat)])
    east = np.array([-np.sin(lon), np.cos(lon), 0.0])
    to_lat, to_lon = np.radians(destination.latitude), np.radians(destination.longitude)
    target = np.array([np.cos(to_lat) * np.cos(to_lon), np.cos(to_lat) * np.sin(to_lon), np.sin(to_lat)])
    return float(target @ north), float(target @ east)


@given(origin=points, destinations=st.lists(points, min_size=1, max_size=10))
# 斜めの向きと緯度の違う2点（東西南北だけでは、式の掛け算を割り算にしても、引き算を足し算にしても答えが変わらない）。
@example(origin=Point(35.0, 139.0), destinations=[Point(36.0, 140.0), Point(34.0, 138.0), Point(35.0, 149.0)])
def test_the_bearing_agrees_with_the_direction_on_the_tangent_plane(origin, destinations):
    """向かい風・追い風の分け方は、走る向きの方位で決まる。斜めの向き・緯度の違う2点でも、北から時計回りの角度が
    別の道で求めた向きと合う（向きの定まらない2点は、比べる成分がどちらも0へ縮むので外さずに比べる）。"""
    bearings = geo.bearing_between_array(
        origin, np.array([p.latitude for p in destinations]), np.array([p.longitude for p in destinations])
    )

    assert bearings.shape == (len(destinations),)
    for destination, bearing in zip(destinations, bearings, strict=True):
        toward_north, toward_east = tangent_plane_direction(origin, destination)
        length = np.hypot(toward_north, toward_east)
        angle = np.radians(bearing)
        assert (length * np.cos(angle), length * np.sin(angle)) == pytest.approx((toward_north, toward_east), abs=1e-9)


# --- nearest_point_index ---


# 最寄りは単位ベクトルの内積で比べるため、約10cmより近い差は区別しない（観測所の間隔に比べて無視できる）。
RESOLUTION_KM = 0.001


def brute_force_nearest_km(location: Point, candidates: list[Point]) -> float:
    return min(geo.haversine_distance_km(location, candidate) for candidate in candidates)


@given(location=points, candidates=st.lists(points, min_size=1, max_size=40))
# 日付変更線の向こうが最寄り。
@example(location=Point(0.0, 179.99), candidates=[Point(0.0, -179.99), Point(0.0, 179.0)])
def test_location_gets_a_point_no_farther_than_any_other_anywhere_on_the_globe(location, candidates):
    index = geo.nearest_point_index(location, candidates)

    assert index is not None
    assert geo.haversine_distance_km(location, candidates[index]) == pytest.approx(
        brute_force_nearest_km(location, candidates), abs=RESOLUTION_KM
    )


def test_no_points_give_no_index():
    assert geo.nearest_point_index(Point(35.0, 139.0), []) is None


@pytest.mark.parametrize("candidates", [[Point(0.0, 1.0), Point(0.0, -1.0)], [Point(0.0, -1.0), Point(0.0, 1.0)]])
def test_nearest_point_index_takes_the_first_listed_of_equally_near_points(candidates):
    index = geo.nearest_point_index(Point(0.0, 0.0), candidates)

    assert index == 0
