"""`domain/way_value_formula.py`——地図の道の値の式の木を、numpyで評価する。

入口は`evaluate_formula`と`way_values_from_formula`。確かめるのはモジュールのdocstringが約束する値の決まり
（丸め・欠けた値の真偽・剰余の符号）で、地図の側は同じ決まりで木を自分の式へ置き換える。

ここで見ないもの:
- 有効勾配の木 → `test_gradient.py`、風の抵抗の比の木 → `test_wind.py`
- 軸の木が地図の配信の値と合うこと → `test_dynamic_way_values.py`
"""

import math

import pytest
from hypothesis import example, given
from hypothesis import strategies as st

from app.domain.way_value_formula import (
    FALSE,
    Binary,
    Round,
    Unary,
    WayValueFormula,
    case,
    const,
    evaluate_formula,
    feature,
    way_values_from_formula,
)

finite = st.floats(min_value=-1e6, max_value=1e6, allow_nan=False)


@given(value=finite, decimals=st.integers(min_value=0, max_value=4))
@example(value=0.25, decimals=1)  # 2進で中点ちょうど: 偶数の側
@example(value=0.35, decimals=1)  # 10進では中点だが2進では中点より下
@example(value=2.675, decimals=2)
@example(value=-0.25, decimals=1)
@example(value=0.0005, decimals=3)
def test_rounding_gives_the_value_of_python_round(value, decimals):
    """配信が丸めた値と、地図が同じ木で丸めた値が揃う（backendの丸めの正本は`round`）。"""
    rounded = evaluate_formula(Round(arg=feature("x"), decimals=decimals), {"x": [value]}, {})
    assert rounded.tolist() == [round(value, decimals)]


@pytest.mark.parametrize(
    ("node", "expected"),
    [
        (Binary(op="lt", left=feature("missing"), right=const(1.0)), 0.0),  # 欠けた値との比べは偽
        (Binary(op="ge", left=feature("missing"), right=const(1.0)), 0.0),
        (Unary(op="not", arg=feature("missing")), 1.0),  # 欠けた値は偽として読む
        (Unary(op="not", arg=const(0.0)), 1.0),
        (Unary(op="not", arg=const(-2.0)), 0.0),  # NaNでも0でもない値は真
        (case(feature("missing"), const(1.0), const(2.0)), 2.0),
        (Unary(op="is_missing", arg=feature("missing")), 1.0),
        (Binary(op="mod", left=const(-10.0), right=const(180.0)), -10.0),  # 剰余は割られる数の符号
    ],
)
def test_a_missing_value_reads_as_false_and_the_remainder_follows_the_dividend(node, expected):
    assert evaluate_formula(node, {}, {}).tolist() == expected


def test_a_way_whose_value_is_undetermined_is_told_apart_from_a_way_without_a_value():
    """地図は決まらない道を「向きで決まらない」、値の無い道を「データなし」と塗り分ける。"""
    formula = WayValueFormula(value=feature("value"), undetermined=Binary(
        op="gt", left=feature("flag"), right=const(0.0)))
    values = way_values_from_formula(
        formula, ["undetermined", "missing", "valued"],
        {"value": [1.0, math.nan, 2.0], "flag": [1.0, 0.0, 0.0]}, {})
    assert values == {"undetermined": None, "valued": 2.0}


def test_a_formula_without_way_materials_gives_a_value_per_way():
    assert way_values_from_formula(WayValueFormula(value=const(3.0), undetermined=FALSE), ["a", "b"], {}, {}) == {
        "a": 3.0, "b": 3.0}
