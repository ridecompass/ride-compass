"""区分に道を振り分ける式（`domain/road_classes.py: class_columns`）と、地図の線の層の値（`layer_columns`）を見る。

区分の型は表の行の写しで、表の制約が守る形はここで見ない（構造仕様15）。配る形は`test_road_class_catalog.py`、表との往復は
`test_road_class_admin_routes.py`が持つ。事実の材料のidは性質だけを表す架空の名前を使う。
"""

import numpy as np
import pytest

from app.domain.attributes import CategoricalColumn
from app.domain.road_classes import NO_DATA_VALUE, Condition, ConditionTerm, class_columns, layer_columns
from tests.road_class_fixture import classification, map_layer, road_classes

# 区間は順に: 分類の値なし・a・b、真偽の真・偽・値なしを、同じ並びで持つ。
COLUMNS = {"cat_a": CategoricalColumn.encode([None, "a", "b"]), "bool_a": np.array([1.0, 0.0, np.nan])}
N = 3


def _term(values: list[str], negated: bool = False, matches_absent: bool = False) -> ConditionTerm:
    return ConditionTerm(fact_values=values, negated=negated, matches_absent=matches_absent)


def _classes(**conditions_by_class: list[Condition]) -> list[str | None]:
    """区分の鍵→条件の分け方1つで、区間ごとに入る区分の鍵。"""
    (column,) = class_columns(road_classes({"k": classification(conditions_by_class)}), COLUMNS, N).values()
    return [column.value_at(i) for i in range(N)]


@pytest.mark.parametrize(
    ("fact_key", "term", "expected"),
    [
        # 分類の事実: 値の一覧に当たる道だけ。値なしは事実なし。
        ("cat_a", _term(["a"]), [None, "c", None]),
        ("cat_a", _term(["a"], negated=True), [None, None, "c"]),
        ("cat_a", _term(["a"], matches_absent=True), ["c", "c", None]),
        # 値の一覧が空なら、事実があるか無いかだけを問う。
        ("cat_a", _term([], negated=True), [None, "c", "c"]),
        # 真偽の事実: 真だけが'true'の事実あり。偽と値なしは事実なし。
        ("bool_a", _term(["true"]), ["c", None, None]),
        # 知らない事実（列が無い）は、どの道にも事実が無い。
        ("unknown", _term(["a"], matches_absent=True), ["c", "c", "c"]),
    ],
)
def test_term_meaning(fact_key: str, term: ConditionTerm, expected: list[str | None]) -> None:
    assert _classes(c=[{fact_key: term}]) == expected


def test_terms_and_conditions_combine() -> None:
    """条件の中の項は全部当たる道、区分は条件のどれかに当たる道。"""
    both = {"cat_a": _term(["a", "b"]), "bool_a": _term(["true"], negated=True, matches_absent=True)}
    assert _classes(c=[both, {"cat_a": _term([], matches_absent=True)}]) == ["c", "c", "c"]


def test_overlapping_classes_leave_road_unclassified() -> None:
    """2つの区分に当たる道は、どちらか一方へ黙って寄せず区分なしにする（並びの順で勝ち負けを決めない）。"""
    assert _classes(ab=[{"cat_a": _term(["a", "b"])}], b=[{"cat_a": _term(["b"])}]) == [None, "ab", None]


def test_layer_values_split_roads_outside_classes_by_the_no_data_fact() -> None:
    """区分の外の道は、層の`no_data_fact_key`の事実が無ければデータなし、あれば値なし（該当なし）。地図の線とルートの帯が読む。"""
    definitions = road_classes(
        {"k": classification({"is_a": [{"cat_a": _term(["a"])}]})},
        map_layers={"k": map_layer().model_copy(update={"no_data_fact_key": "cat_a"})},
    )
    (column,) = layer_columns(definitions, {**COLUMNS, **class_columns(definitions, COLUMNS, N)}, N).values()
    assert [column.value_at(i) for i in range(N)] == [NO_DATA_VALUE, "is_a", None]
