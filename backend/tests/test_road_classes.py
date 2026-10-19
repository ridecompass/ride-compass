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
    check_groups_change,
)

CAT_A, CAT_B = sorted(fact for fact, dtype in ROAD_CLASS_FACTS.items() if dtype == "categorical")[:2]
BOOL_A = sorted(fact for fact, dtype in ROAD_CLASS_FACTS.items() if dtype == "boolean")[0]


def row(key: str, *match: dict, **fields) -> dict:
    return {"key": key, "label": key, "description": f"{key}の道", "match": list(match) or [{CAT_A: [key]}], **fields}


def group(*rows: dict, group_key: str = "group_a", **fields) -> RoadClassGroup:
    return RoadClassGroup.model_validate({
        "group_key": group_key, "label": "群", "palette": "ordered", "rows": list(rows) or [row("a")], **fields})


def published(*rows: dict, group_key: str = "group_a") -> RoadClassGroup:
    return group(*rows, group_key=group_key, is_published=True)


def groups(*items: RoadClassGroup) -> dict[str, RoadClassGroup]:
    return {item.group_key: item for item in items}


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
    ({"rows": [row("a", former_keys=["group_b.x", "group_b.x"])]}, "前の鍵が重なっています"),
    ({"rows": [row("a", former_keys=["group_a.a"])]}, "前の鍵が自分の鍵と同じです ['group_a.a']"),
    ({"palette": "nominal"}, "色相の起点は nominal の群だけが持ちます"),
    ({"hue_slot": 3}, "色相の起点は nominal の群だけが持ちます"),
], ids=["unknown_fact", "boolean_fact_with_text", "categorical_fact_with_boolean", "duplicated_row_key",
        "always_excluded_row_without_exclude", "duplicated_former_key", "former_key_is_own_key",
        "nominal_without_hue", "ordered_with_hue"])
def test_a_group_the_tiles_and_the_road_network_cannot_judge_is_refused(fields, named):
    # 道路網とタイルに無い事実・型の違う値で書いた行は、どの道にも当たらず、地図の凡例に誰も入らない行になる。
    with pytest.raises(ValidationError, match=named.replace("[", r"\[").replace("]", r"\]")):
        group(**fields)


@pytest.mark.parametrize(("before", "after", "refused"), [
    ({}, groups(published(row("b"))), None),
    (groups(group(row("a"))), {}, None),
    (groups(published()), groups(group()), r"公開した群 \['group_a'\] は下書きへ戻せません"),
    (groups(published(row("a"), row("b"))), groups(published(row("a"))), r"公開していた行の鍵 \['group_a.b'\] を消すには"),
    (groups(published()), groups(published(row("a1", former_keys=["group_a.a"]), row("a2", former_keys=["group_a.a"]))),
     None),
    (groups(published(row("a"), row("b"))), groups(published(row("ab", former_keys=["group_a.a", "group_a.b"]))), None),
    (groups(published(row("b", former_keys=["group_a.a"]))), groups(published(row("c", former_keys=["group_a.b"]))),
     r"公開していた行の鍵 \['group_a.a'\]"),
    (groups(published(), published(row("x", former_keys=["group_a.a"]), group_key="group_b")),
     groups(published(row("x", former_keys=["group_a.a"]), group_key="group_b")), None),
    (groups(published(), group(row("x", former_keys=["group_a.a"]), group_key="group_b")),
     groups(group(row("x", former_keys=["group_a.a"]), group_key="group_b")), r"公開していた行の鍵 \['group_a.a'\]"),
], ids=["new_group", "deleting_a_draft", "published_to_draft", "published_row_lost", "published_row_split",
        "published_rows_merged", "renamed_twice_dropping_the_first_key", "published_group_moved_to_another_group",
        "published_group_moved_to_a_draft"])
def test_every_key_a_published_group_had_stays_with_a_published_row(before, after, refused):
    # 公開した群の行の鍵（前の鍵も）は利用者の避け方の設定に残る。引き継ぎ先なしに消すと、選んだ段が黙って既定へ戻る。
    if refused is None:
        check_groups_change(before, after)
    else:
        with pytest.raises(RoadClassPublishedError, match=refused):
            check_groups_change(before, after)
