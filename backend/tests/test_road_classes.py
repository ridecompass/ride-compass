"""`domain/road_classes.py`——道の区分の群と行の検査と、道の事実から行を決める判定。

ここで見ないもの:
- 群の読み書きとプロセス内の群の差し替え・公開した群を守る断りが書き込みの前に効くこと → `test_road_class_service.py`
- 断りを管理APIが状態コードへ変えること → `test_road_class_admin_routes.py`
- 今の区分を同じ意味の群へ組むこと → `test_road_classes_apply.py`

道の事実は、型ごとに本物の事実の一覧（`ROAD_CLASS_FACTS`）から選ぶ。
"""

import pytest
from pydantic import ValidationError

from app.domain.road_classes import (
    ROAD_CLASS_FACTS,
    RoadClassGroup,
    RoadClassPublishedError,
    check_group_change,
    check_group_deletable,
)

CAT_A, CAT_B = sorted(fact for fact, dtype in ROAD_CLASS_FACTS.items() if dtype == "categorical")[:2]
BOOL_A = sorted(fact for fact, dtype in ROAD_CLASS_FACTS.items() if dtype == "boolean")[0]


def row(key: str, *match: dict, **fields) -> dict:
    return {"key": key, "label": key, "description": f"{key}の道", "match": list(match) or [{CAT_A: [key]}], **fields}


def group(*rows: dict, **fields) -> RoadClassGroup:
    return RoadClassGroup.model_validate({
        "group_key": "group_a", "label": "群", "palette": "ordered", "rows": list(rows) or [row("a")], **fields})


@pytest.mark.parametrize(("facts", "expected"), [
    ({CAT_A: "x", CAT_B: "y"}, "both"),
    ({CAT_A: "x"}, "either"),
    ({CAT_A: "z"}, "either"),
    ({BOOL_A: True}, "either"),
    ({BOOL_A: None, CAT_A: None}, None),
], ids=["first_row_whose_condition_holds_wins", "a_condition_needs_all_its_facts", "any_condition_of_a_row",
        "boolean_fact", "no_row_holds"])
def test_a_way_enters_the_first_row_any_of_whose_conditions_holds(facts, expected):
    # 群の中で上の行が先に当たる（自転車道とレーンの両方の印を持つ道は、上の自転車道に入る）。
    classes = group(
        row("both", {CAT_A: ["x"], CAT_B: ["y"]}),
        row("either", {CAT_A: ["z", "x"]}, {BOOL_A: [True]}),
    )

    assert classes.row_key_of(facts) == expected


@pytest.mark.parametrize(("fields", "named"), [
    ({"rows": [row("a", {"no_such_fact": ["x"]})]}, "道の事実 no_such_fact はありません"),
    ({"rows": [row("a", {BOOL_A: ["true"]})]}, f"道の事実 {BOOL_A} の値は真偽で書きます"),
    ({"rows": [row("a", {CAT_A: [True]})]}, f"道の事実 {CAT_A} の値は文字列で書きます"),
    ({"rows": [row("a"), row("a")]}, "行の鍵が重なっています ['a']"),
    ({"rows": [row("a", always_excluded=True)]}, "いつも通らない行の既定の段は exclude です"),
    ({"rows": [row("a", former_key="a")]}, "前の鍵が自分の鍵と同じです"),
    ({"palette": "nominal"}, "色相の起点は nominal の群だけが持ちます"),
    ({"hue_slot": 3}, "色相の起点は nominal の群だけが持ちます"),
], ids=["unknown_fact", "boolean_fact_with_text", "categorical_fact_with_boolean", "duplicated_row_key",
        "always_excluded_row_without_exclude", "former_key_is_own_key", "nominal_without_hue", "ordered_with_hue"])
def test_a_group_the_tiles_and_the_road_network_cannot_judge_is_refused(fields, named):
    # 道路網とタイルに無い事実・型の違う値で書いた行は、どの道にも当たらず、地図の凡例に誰も入らない行になる。
    with pytest.raises(ValidationError, match=named.replace("[", r"\[").replace("]", r"\]")):
        group(**fields)


@pytest.mark.parametrize(("before", "after", "refused"), [
    (None, group(row("b"), is_published=True), None),
    (group(row("a")), group(row("b")), None),
    (group(row("a"), is_published=True), group(row("a")), "下書きへ戻せません"),
    (group(row("a"), row("b"), is_published=True), group(row("a"), is_published=True), r"行 \['b'\] を消すには"),
    (group(row("a"), is_published=True), group(row("a1", former_key="a"), row("a2", former_key="a"), is_published=True), None),
], ids=["new_group", "draft_group", "published_to_draft", "published_row_lost", "published_row_split"])
def test_a_published_group_keeps_every_row_key_a_user_may_have_chosen(before, after, refused):
    # 公開した群の行の鍵は利用者の避け方の設定に残る。引き継ぎ先なしに消すと、選んだ段が黙って既定へ戻る。
    if refused is None:
        check_group_change(before, after)
    else:
        with pytest.raises(RoadClassPublishedError, match=refused):
            check_group_change(before, after)


def test_a_published_group_cannot_be_deleted():
    check_group_deletable(group())
    with pytest.raises(RoadClassPublishedError, match="公開した群 group_a は消せません"):
        check_group_deletable(group(is_published=True))
