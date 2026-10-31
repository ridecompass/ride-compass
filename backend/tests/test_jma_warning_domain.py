"""`domain/jma_warning.py`——警報・注意報の電文の1地域ぶんから、サイクリングに関わる発表中のものを取り出す。

入口は`warning_level`（種別の名称→警戒の段）・`WarningBulletin.kinds_for`
（電文から地点の種別を引く）・`collect_active_warnings`（電文の一覧から地点の発表中の警報を集める）。出さない種別の表`NOT_RELEVANT_TO_CYCLING`は差し替えず、本物の表の名称から種別を
組み立てる——どの種別を出さないかには踏み込まない。

ここで見ないもの:
- 電文の形を`WarningBulletin`へ解くこと・コードを種別の名称へ、状態を発表中かへ読み替えること → `test_jma_warning_client.py`
- 地点から区域を引くこと → `test_jma_area_boundaries.py`
- 取った電文と区域を集める処理へ渡すこと → `test_warning_service.py`
"""

import pytest

from app.domain.jma_warning import (
    NOT_RELEVANT_TO_CYCLING,
    AreaWarningKind,
    WarningBulletin,
    collect_active_warnings,
    warning_level,
)

IRRELEVANT = min(NOT_RELEVANT_TO_CYCLING)


def _kind(name: str, active: bool = True, additions: tuple[str, ...] = (), code: str = "t_code") -> AreaWarningKind:
    return AreaWarningKind(code=code, name=name, active=active, additions=additions)


def _collect(kinds: list[AreaWarningKind]):
    bulletin = WarningBulletin(class20_kinds={"1310100": tuple(kinds)}, class10_kinds={})
    return collect_active_warnings([bulletin], "1310100", "130010")


def test_active_warnings_come_out_in_order_with_their_code_name_level_and_additions():
    """出さない表に無い名称は出す——配信元が新しい種別を出したとき、黙って隠さない。"""
    warnings = _collect([_kind("架空警報", additions=("土砂災害",), code="t1"), _kind("架空注意報", code="t2")])

    assert [warning.model_dump() for warning in warnings] == [
        {"code": "t1", "name": "架空警報", "level": "warning", "additions": ["土砂災害"]},
        {"code": "t2", "name": "架空注意報", "level": "advisory", "additions": []},
    ]


@pytest.mark.parametrize(
    ("name", "level"),
    [
        ("大雨注意報", "advisory"),
        ("大雨警報", "warning"),
        ("大雨危険警報", "severe_warning"),
        ("大雨特別警報", "emergency_warning"),
    ],
)
def test_the_level_follows_the_last_word_of_the_name(name, level):
    """段を取り違えると、警戒度バッジの色が発表の重さと食い違う。"""
    assert warning_level(name) == level


def test_the_same_kind_in_several_bulletins_comes_out_once():
    """種類ごとの電文に同じ種別が重なって現れても、バッジは1つ。"""
    bulletins = [
        WarningBulletin(class20_kinds={"1310100": (_kind("架空警報", code="t1"),)}, class10_kinds={}),
        WarningBulletin(
            class20_kinds={"1310100": (_kind("架空警報", code="t1"), _kind("架空注意報", code="t2"))}, class10_kinds={}
        ),
    ]

    assert [warning.code for warning in collect_active_warnings(bulletins, "1310100", "130010")] == ["t1", "t2"]


@pytest.mark.parametrize(
    "kind",
    [_kind("架空警報", active=False), _kind(IRRELEVANT)],
    ids=["lifted", "not_relevant_to_cycling"],
)
def test_lifted_and_irrelevant_kinds_are_left_out(kind):
    assert _collect([kind]) == []


AREA = (_kind("架空警報"),)
SUBDIVISION = (_kind("架空注意報"),)
NOTHING: tuple[AreaWarningKind, ...] = ()


@pytest.mark.parametrize(
    ("class20_kinds", "class10_kinds", "expected"),
    [
        ({"1310100": NOTHING}, {"130010": SUBDIVISION}, NOTHING),
        ({}, {"130010": SUBDIVISION}, SUBDIVISION),
        ({"1310200": AREA}, {"130020": SUBDIVISION}, None),
    ],
    ids=["area_first_even_saying_nothing", "subdivision_when_no_area_item", "neither"],
)
def test_the_area_item_is_used_and_the_subdivision_only_when_the_bulletin_has_no_area_item(
    class20_kinds, class10_kinds, expected
):
    bulletin = WarningBulletin(class20_kinds=class20_kinds, class10_kinds=class10_kinds)
    assert bulletin.kinds_for("1310100", "130010") == expected
