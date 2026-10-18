"""`domain/wind_grid.py`——地図の風・降水の格子点をどこに敷くか。

入口は`generate_wind_grid_detail_points`（問い合わせ範囲の詳細格子）・`count_wind_grid_detail_points`
（点を作らずに数える）。

ここで見ないもの:
- 対象範囲全体の粗い格子（`generate_wind_grid_points`。詳細格子へ間隔を渡すだけ） → `test_weather_route.py`
- 点数の上限・間隔の下限で断ること、格子点へ予報を補間すること → `test_weather_route.py`
- 道の風の格子（`domain/wind.py: WindLattice`） → `test_wind.py`
"""

from hypothesis import given
from hypothesis import strategies as st

from app.domain.region import BoundingBox
from app.domain.wind_grid import (
    WIND_GRID_DETAIL_MIN_SPACING_DEG,
    count_wind_grid_detail_points,
    generate_wind_grid_detail_points,
)

AREA = BoundingBox(min_latitude=34.8, min_longitude=138.9, max_latitude=36.6, max_longitude=140.9)

#: 画面が求めうる間隔（下限から粗い格子の間隔まで）。
SPACINGS = st.floats(WIND_GRID_DETAIL_MIN_SPACING_DEG, 0.1)


def _box(south, west, north, east) -> BoundingBox:
    return BoundingBox(min_latitude=south, min_longitude=west, max_latitude=north, max_longitude=east)


def _pairs(points) -> list[tuple[float, float]]:
    return [(p.latitude, p.longitude) for p in points]


@st.composite
def boxes(draw) -> BoundingBox:
    """対象範囲と重なりうる、表示中の範囲くらいの矩形。"""
    south = draw(st.floats(34.6, 36.6))
    west = draw(st.floats(138.7, 140.9))
    return _box(south, west, south + draw(st.floats(0.001, 0.08)), west + draw(st.floats(0.001, 0.08)))


def test_coordinates_carry_no_floating_point_noise():
    """画面は前回の点を緯度経度の一致で見分ける。353 × 0.1 は 35.300000000000004 になる。"""
    points = generate_wind_grid_detail_points(AREA, _box(35.29, 139.29, 35.31, 139.31), 0.1)

    assert _pairs(points) == [(35.2, 139.2), (35.2, 139.3), (35.3, 139.2), (35.3, 139.3)]


@given(boxes(), SPACINGS)
def test_counting_agrees_with_the_points_made(view, spacing):
    """上限で断るかは点を作る前に数えて決める。数えた数と作る数が食い違うと、上限が効かない。"""
    assert count_wind_grid_detail_points(AREA, view, spacing) == len(
        generate_wind_grid_detail_points(AREA, view, spacing)
    )


def test_a_view_that_only_touches_the_area_gets_no_points():
    view = _box(35.0, 140.9, 35.5, 141.5)  # 対象範囲の東の辺に接するだけ

    assert generate_wind_grid_detail_points(AREA, view, 0.02) == []
