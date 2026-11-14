"""`domain/axis_templates.py`——軸の得点を求める区分線形の演算。

入口は`evaluate_breakpoint_linear`。配列で受け、欠損はNaNで返す。
"""

import bisect
import math

import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain.axis_templates import evaluate_breakpoint_linear


def _straight_line(x: float, breakpoints: list[tuple[float, float]]) -> float:
    """折れ線を1点ずつ素直に引く（両端は端の値で止める）。"""
    if math.isnan(x):
        return math.nan
    xs = [p[0] for p in breakpoints]
    if x <= xs[0]:
        return breakpoints[0][1]
    if x >= xs[-1]:
        return breakpoints[-1][1]
    right = bisect.bisect_right(xs, x)
    (x0, y0), (x1, y1) = breakpoints[right - 1], breakpoints[right]
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0)


@st.composite
def _breakpoints(draw):
    xs = sorted(draw(st.sets(st.integers(min_value=-1000, max_value=1000), min_size=1, max_size=6)))
    ys = draw(st.lists(st.floats(min_value=0.0, max_value=100.0), min_size=len(xs), max_size=len(xs)))
    return [(float(x), y) for x, y in zip(xs, ys)]


_material_values = st.one_of(st.floats(min_value=-2000.0, max_value=2000.0), st.just(math.nan))


@given(breakpoints=_breakpoints(), values=st.lists(_material_values, min_size=1, max_size=20))
def test_the_score_follows_the_line_between_the_breakpoints_and_stops_at_its_ends(breakpoints, values):
    """欠損（NaN）は得点を持たない。端より外は端の得点で止まる。"""
    scores = evaluate_breakpoint_linear(np.array(values), breakpoints)

    expected = [_straight_line(x, breakpoints) for x in values]
    assert scores.tolist() == pytest.approx(expected, rel=1e-9, abs=1e-9, nan_ok=True)
