"""区分に道を振り分ける式（`domain/road_classes.py: class_indices`）を見る。

区分の型は表の行の写しで、表の制約が守る形はここで見ない（構造仕様15）。配る形は`test_road_class_catalog.py`、
表との往復は`test_road_class_admin_routes.py`が持つ。事実の材料のidは性質だけを表す架空の名前を使う。
"""

import numpy as np
import pytest

from app.domain.attributes import CategoricalColumn
from app.domain.road_classes import Condition, ConditionTerm, RoadClass, RoadClassification, class_indices

# 区間は順に: 分類の値なし・a・b、真偽の真・偽・値なしを、同じ並びで持つ。
COLUMNS = {
    "cat_a": CategoricalColumn.encode([None, "a", "b"]),
    "bool_a": np.array([1.0, 0.0, np.nan]),
}
N = 3


def _term(values: list[str], negated: bool = False, matches_absent: bool = False) -> ConditionTerm:
    return ConditionTerm(fact_values=values, negated=negated, matches_absent=matches_absent)


def _classification(*conditions_by_class: list[Condition]) -> RoadClassification:
    return RoadClassification(
        label="分け方",
        description="",
        is_published=True,
        classes={
            f"class_{position}": RoadClass(
                label=f"区分{position}", description="", sort_order=position, former_keys=[], conditions=conditions
            )
            for position, conditions in enumerate(conditions_by_class)
        },
    )


@pytest.mark.parametrize(
    ("fact_key", "term", "expected"),
    [
        # 分類の事実: 値の一覧に当たる道だけ。値なしは事実なし。
        ("cat_a", _term(["a"]), [-1, 0, -1]),
        ("cat_a", _term(["a"], negated=True), [-1, -1, 0]),
        ("cat_a", _term(["a"], matches_absent=True), [0, 0, -1]),
        # 値の一覧が空なら、事実があるか無いかだけを問う。
        ("cat_a", _term([], negated=True), [-1, 0, 0]),
        ("cat_a", _term([], matches_absent=True), [0, -1, -1]),
        # 真偽の事実: 真だけが'true'の事実あり。偽と値なしは事実なし。
        ("bool_a", _term(["true"]), [0, -1, -1]),
        ("bool_a", _term(["true"], negated=True, matches_absent=True), [-1, 0, 0]),
        # 知らない事実（列が無い）は、どの道にも事実が無い。
        ("unknown", _term(["a"]), [-1, -1, -1]),
        ("unknown", _term(["a"], matches_absent=True), [0, 0, 0]),
    ],
)
def test_term_meaning(fact_key: str, term: ConditionTerm, expected: list[int]) -> None:
    classification = _classification([{fact_key: term}])
    assert class_indices(classification, COLUMNS, N).tolist() == expected


def test_terms_and_conditions_combine() -> None:
    """条件の中の項は全部当たる道、区分は条件のどれかに当たる道。"""
    classification = _classification(
        [{"cat_a": _term(["a", "b"]), "bool_a": _term(["true"], negated=True, matches_absent=True)}, {"cat_a": _term([], matches_absent=True)}],
    )
    assert class_indices(classification, COLUMNS, N).tolist() == [0, 0, 0]
    classification = _classification([{"cat_a": _term(["a", "b"]), "bool_a": _term(["true"])}])
    assert class_indices(classification, COLUMNS, N).tolist() == [-1, -1, -1]


def test_overlapping_classes_leave_road_unclassified() -> None:
    """2つの区分に当たる道は、どちらか一方へ黙って寄せず区分なしにする（並びの順で勝ち負けを決めない）。"""
    classification = _classification(
        [{"cat_a": _term(["a", "b"])}],
        [{"cat_a": _term(["b"])}],
        [{"cat_a": _term([], matches_absent=True)}],
    )
    assert class_indices(classification, COLUMNS, N).tolist() == [2, 0, -1]
