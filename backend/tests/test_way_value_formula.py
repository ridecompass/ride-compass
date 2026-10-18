"""`domain/way_value_formula.py`——地図の道の値の式の木を、numpyで評価する。

入口は`evaluate_formula`と`way_values_from_formula`。確かめるのはモジュールのdocstringが約束する値の決まり
（丸め）で、地図の側は同じ決まりで木を自分の式へ置き換える。

ここで見ないもの:
- 有効勾配の木 → `test_gradient.py`、風の抵抗の比の木 → `test_wind.py`
- 軸の木が地図の配信の値と合うこと・欠けた値の真偽 → `test_dynamic_way_values.py`
"""


from hypothesis import example, given
from hypothesis import strategies as st

from app.domain.way_value_formula import (
    FALSE,
    Round,
    WayValueFormula,
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


def test_a_formula_without_way_materials_gives_a_value_per_way():
    assert way_values_from_formula(WayValueFormula(value=const(3.0), undetermined=FALSE), ["a", "b"], {}, {}) == {
        "a": 3.0, "b": 3.0}
