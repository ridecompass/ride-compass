"""`domain/gradient.py`——道路自身の勾配と向き・走行方位から、その向きに辿ったときの勾配を求める式の木。

入口は、勾配の材料の木（`gradient_by_direction`を`travel_direction_formula`で選ぶ木）を道ごとの材料と走行方位で評価した
値（`domain/way_value_formula.py: way_values_from_formula`）。走行方位が決めるのは符号だけで、直角に近い向きは値が
決まらない。

ここで見ないもの:
- 勾配の道ごとの材料を集めてタイルへ配ること → `test_gradient_way_service.py`
- 木の演算そのもの → `test_way_value_formula.py`
"""

import math

import pytest
from hypothesis import example, given
from hypothesis import strategies as st

from app.domain.gradient import (
    LENS_PERPENDICULAR_BAND_DEG,
    ROAD_BEARING_LEAF,
    gradient_by_direction,
    travel_direction_formula,
)
from app.domain.way_value_formula import feature, way_values_from_formula

GRADIENT = "gradient"
FORMULA = travel_direction_formula(*gradient_by_direction(feature(GRADIENT)))

# 直角の帯の端ちょうど（帯は端を含む）と、そこから外へわずかに出た角度。
BAND_EDGE = 90.0 - LENS_PERPENDICULAR_BAND_DEG
JUST_OUTSIDE = BAND_EDGE - 0.1

UNDETERMINED = "undetermined"
NO_VALUE = "no value"


def effective_gradient(gradient: float, road_bearing: float, travel_bearing: float) -> float | str:
    values = way_values_from_formula(
        FORMULA, ["way"], {GRADIENT: [gradient], ROAD_BEARING_LEAF: [road_bearing]}, {"bearing_deg": travel_bearing})
    if "way" not in values:
        return NO_VALUE
    value = values["way"]
    return UNDETERMINED if value is None else value


@pytest.mark.parametrize(
    ("gradient", "road_bearing", "travel_bearing", "expected"),
    [
        (6.0, 0.0, JUST_OUTSIDE, 6.0),  # 帯のすぐ外は、角度差があっても急さはそのまま
        (6.0, 0.0, 180.0 - JUST_OUTSIDE, -6.0),  # 逆向き寄りに辿ると登りと下りが入れ替わる
        (6.0, 350.0, 10.0, 6.0),  # 北をまたいでも、向きの差は20度
        (6.0, 10.0, 350.0 - 180.0, -6.0),  # 走行方位から見て負の側に寄った道の逆向き
        (6.0, 0.0, BAND_EDGE, UNDETERMINED),  # 直角に近い向きは値が決まらない（帯の両端ちょうど）
        (6.0, 0.0, 180.0 - BAND_EDGE, UNDETERMINED),
        (6.0, math.nan, 0.0, -6.0),  # 向きを持たない道（始点と終点が同じ）は逆向きの値
        (math.nan, 0.0, 0.0, NO_VALUE),  # 勾配の無い道は、値の無い道（向きで決まらない道とは別）
        (math.nan, 0.0, BAND_EDGE, UNDETERMINED),
    ],
)
def test_the_travel_bearing_decides_only_the_sign_and_a_near_perpendicular_road_is_undetermined(
    gradient, road_bearing, travel_bearing, expected
):
    assert effective_gradient(gradient, road_bearing, travel_bearing) == expected


angles = st.floats(min_value=-720.0, max_value=720.0, allow_nan=False)
gradients = st.floats(min_value=-30.0, max_value=30.0, allow_nan=False)


@given(gradient=gradients, road_bearing=angles, travel_bearing=angles)
@example(gradient=6.0, road_bearing=0.0, travel_bearing=BAND_EDGE)
@example(gradient=6.0, road_bearing=-BAND_EDGE, travel_bearing=0.0)
def test_a_road_is_undetermined_exactly_within_the_band_around_perpendicular(gradient, road_bearing, travel_bearing):
    """帯の判定は角度の差を180度で畳んだ値で行う（cosの大小で比べると、直角の左右で浮動小数の差だけ食い違う）。"""
    folded = (road_bearing - travel_bearing) % 180
    value = effective_gradient(gradient, road_bearing, travel_bearing)
    assert (value == UNDETERMINED) == (abs(folded - 90) <= LENS_PERPENDICULAR_BAND_DEG)


@given(gradient=gradients, road_bearing=angles, travel_bearing=angles)
def test_the_value_keeps_the_steepness_of_the_road(gradient, road_bearing, travel_bearing):
    value = effective_gradient(gradient, road_bearing, travel_bearing)
    assert value == UNDETERMINED or abs(value) == abs(gradient)


@given(gradient=gradients, road_bearing=angles, travel_bearing=angles)
def test_the_reverse_row_of_the_same_road_gives_the_same_value(gradient, road_bearing, travel_bearing):
    """同じ道路を逆の向きで持つ行（向きが180度回り、勾配の符号が反転する）からも、同じ答えになる。"""
    assert effective_gradient(gradient, road_bearing, travel_bearing) == effective_gradient(
        -gradient, road_bearing + 180.0, travel_bearing
    )
