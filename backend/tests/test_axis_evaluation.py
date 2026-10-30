"""`domain/axis_evaluation.py`——軸1本の評価（`evaluate_axis`）と生値（`AxisEvaluation.raw`・`raw_values`）。

ここで見ないもの:
- 軸が軸を参照するときの並べ替え・軸の集合の評価（`evaluate_axes_array`等） → `test_axis_hierarchy.py`
- 折れ線の補間と対応表の引き方そのもの → `test_axis_templates.py`
- 折れ線の点数と、点数から値の大きさへの戻し（`BreakpointLinearShape`） → `test_axis_definitions.py`

評価は材料カタログを読まないので、材料は架空の名前で与える。
"""

import math

import numpy as np

from app.domain import axis_evaluation
from app.domain.attributes import CategoricalColumn
from app.domain.axis_definitions import CategoricalShape, MaterialTerm, PriorityCondition
from tests.axis_system_fixture import linear, shaped_axis

NAN = float("nan")


def scores(values) -> list:
    """NaNをNoneへ（配列の比較を読みやすくする）。"""
    return [None if math.isnan(v) else v for v in np.asarray(values, dtype=float).tolist()]


class TestBreakpointScores:
    def test_a_missing_optional_material_adds_nothing(self):
        shape = linear(MaterialTerm(material="a", weight=2.0), MaterialTerm(material="b", required=False))

        result = axis_evaluation.evaluate_axis(shaped_axis(shape), {"a": np.array([2.0]), "b": np.array([NAN])})

        assert scores(result.score) == [40.0]

    def test_a_road_with_every_material_missing_is_unscored_even_when_all_are_optional(self):
        shape = linear(MaterialTerm(material="a", required=False), MaterialTerm(material="b", required=False))

        result = axis_evaluation.evaluate_axis(
            shaped_axis(shape), {"a": np.array([NAN, NAN]), "b": np.array([NAN, 0.0])}
        )

        assert scores(result.score) == [None, 0.0]


class TestPriorityConditions:
    def test_the_first_matching_condition_in_order_wins(self):
        definition = shaped_axis(
            linear("num_a"),
            priority_overrides=[
                PriorityCondition(material="flag", equals="true", value=1.0),
                PriorityCondition(material="cat", equals="x", value=2.0),
            ],
        )

        result = axis_evaluation.evaluate_axis(
            definition,
            {"num_a": np.zeros(3), "flag": np.array([1.0, 0.0, NAN]), "cat": CategoricalColumn.encode(["x", "x", "y"])},
        )

        assert scores(result.score) == [1.0, 2.0, 0.0]


class TestRawValues:
    def test_a_mapping_axis_has_no_raw_value(self):
        shape = CategoricalShape(material="cat", mapping={"x": 1.0})

        evaluated = axis_evaluation.evaluate_axis(shaped_axis(shape), {"cat": np.array(["x"], dtype=object)}, keep_raw=True)

        assert evaluated.raw is None
        assert axis_evaluation.raw_values(shape, {"cat": ["x", "y"]}, 2) == [None, None]
