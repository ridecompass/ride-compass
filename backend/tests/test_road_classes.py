"""区分に道を振り分ける式（`domain/road_classes.py: class_columns`）と、地図の線の層の値（`layer_columns`）と、
区分の列を引く表が前の鍵の区分の名でも当たること（`ClassColumn`）と、コードの宣言に無い名指し（`undeclared_references`）を見る。

区分の型は表の行の写しで、表の制約が守る形はここで見ない（構造仕様15）。配る形は`test_road_class_catalog.py`、表との往復と
書く側で断ること（の受け渡し）は`test_road_class_admin_routes.py`が持つ。振り分けの事実の材料のidは性質だけを表す架空の名前を使い、
宣言に無い名指しは宣言の実在が関心なので本物の宣言から選ぶ。
"""

import numpy as np
import pytest

from app.domain.attributes import CategoricalColumn
from app.domain.cycling_speed import BASE_CRR_ID
from app.domain.map_display import MAP_LAYER_CATEGORIES
from app.domain.material_catalog import MATERIAL_CATALOG
from app.domain.road_classes import (
    NO_DATA_VALUE,
    Condition,
    ConditionTerm,
    RoadClassDefinitions,
    class_columns,
    layer_columns,
    undeclared_references,
)
from tests.road_class_fixture import classification, fact_is, map_layer, road_classes

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
    both = {"cat_a": _term(["a"]), "bool_a": _term(["true"], negated=True, matches_absent=True)}
    # 3行目は項の片方（真偽）にだけ当たる。項を OR で結ぶと区分に入る。
    assert _classes(c=[both, {"cat_a": _term([], matches_absent=True)}]) == ["c", "c", None]


def test_overlapping_classes_leave_road_unclassified() -> None:
    """2つの区分に当たる道は、どちらか一方へ黙って寄せず区分なしにする（並びの順で勝ち負けを決めない）。"""
    assert _classes(ab=[{"cat_a": _term(["a", "b"])}], b=[{"cat_a": _term(["b"])}]) == [None, "ab", None]


@pytest.mark.parametrize(
    ("table", "expected"),
    [
        # 今の鍵で引ければ、前の名より先に効く。
        ({"c": 1.0, "old": 2.0}, [None, 1.0, None]),
        # 今の鍵で引けなければ、前の名のうち先に書いた方。ほかの分け方を指す前の鍵は読まない。
        ({"older": 3.0, "old": 2.0, "elsewhere": 4.0}, [None, 2.0, None]),
        ({"elsewhere": 4.0}, [None, None, None]),
    ],
)
def test_tables_reading_a_class_column_fall_back_to_former_class_names(table: dict, expected: list) -> None:
    """改名した区分の道は、表（軸の対応表・0次条件・転がり抵抗）を直すまで前の名で引かれ、点数・一致が黙って抜けない。"""
    definitions = road_classes(
        {"k": classification({"c": [fact_is("cat_a", "a")]}, former_keys={"c": ["k.old", "k.older", "j.elsewhere"]})}
    )
    (column,) = class_columns(definitions, COLUMNS, N).values()
    assert [None if np.isnan(v) else v for v in column.lookup(table).tolist()] == expected
    assert column.equals("older").tolist() == [False, True, False]
    assert column.take(np.array([1])).equals("old").tolist() == [True]


def test_layer_values_split_roads_outside_classes_by_the_no_data_fact() -> None:
    """区分の外の道は、層の`no_data_fact_key`の事実が無ければデータなし、あれば値なし（該当なし）。地図の線とルートの帯が読む。"""
    definitions = road_classes(
        {"k": classification({"is_a": [{"cat_a": _term(["a"])}]})},
        map_layers={"k": map_layer().model_copy(update={"no_data_fact_key": "cat_a"})},
    )
    (column,) = layer_columns(definitions, {**COLUMNS, **class_columns(definitions, COLUMNS, N)}, N).values()
    assert [column.value_at(i) for i in range(N)] == [NO_DATA_VALUE, "is_a", None]


DECLARED_FACT = next(iter(MATERIAL_CATALOG))
UNKNOWN = "no_such_name"


def _naming(*, fact: str = DECLARED_FACT, group: str = MAP_LAYER_CATEGORIES[0].key, tone: str | None = "dark",
            no_data_fact: str | None = DECLARED_FACT, tuning_id: str = BASE_CRR_ID) -> RoadClassDefinitions:
    """コードの宣言を名指す欄を全部持つ全体。既定はどれも宣言にある名。"""
    return road_classes(
        {"k": classification({"c": [fact_is(fact, "a")]})},
        map_layers={"k": map_layer().model_copy(update={"group_key": group, "tone": tone, "no_data_fact_key": no_data_fact})},
        rolling_resistance_classification="k",
        rolling_resistance_classes={"k": {"c": tuning_id}},
    )


@pytest.mark.parametrize(
    ("definitions", "undeclared"),
    [
        (_naming(), None),
        # 任意の欄は、書いていなければ名指していない。
        (_naming(tone=None, no_data_fact=None), None),
        (_naming(fact=UNKNOWN), UNKNOWN),
        (_naming(group=UNKNOWN), UNKNOWN),
        (_naming(tone=UNKNOWN), UNKNOWN),
        (_naming(no_data_fact=UNKNOWN), UNKNOWN),
        (_naming(tuning_id="speed.crr_pavd"), "speed.crr_pavd"),
    ],
)
def test_names_missing_from_the_code_declarations(definitions: RoadClassDefinitions, undeclared: str | None) -> None:
    """宣言に無い名を指す欄を、その名で1件ずつ挙げる（書く側が断る文になる）。"""
    problems = undeclared_references(definitions)
    assert [undeclared in problem for problem in problems] == ([] if undeclared is None else [True])
