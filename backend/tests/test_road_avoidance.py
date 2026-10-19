"""`domain/road_avoidance.py: resolve_road_avoidance`——要求の避け方を、今の区分の行へ揃える規則。

ここで見ないもの:
- 段の結果が除外・勾配の上限と合わさって探索から除く区間になること → `test_hard_filters.py`
- 選べる行の並びと、除外タブへ配る形 → `test_road_class_catalog.py`
- 割り増しが区間の費用に掛かること → `test_leg_costs.py`
"""

import pytest

from app.domain.road_avoidance import resolve_road_avoidance
from app.domain.road_classes import AvoidanceClassification, AvoidanceOverride, AvoidanceSection
from tests.road_class_fixture import classification, road_classes

DEFINITIONS = road_classes(
    {
        "kind": classification({"a": [], "b": [], "fixed": []}, former_keys={"a": ["old.x", "old.y"]}),
        "draft": classification({"a": []}).model_copy(update={"is_published": False}),
    },
    avoidance_sections={"s": AvoidanceSection(label="見出し", description="", sort_order=0)},
    avoidance_classifications={
        "kind": AvoidanceClassification(section_key="s", sort_order=0, overrides={
            "b": AvoidanceOverride(section_key=None, default_level="avoid", selectable=True),
            "fixed": AvoidanceOverride(section_key=None, default_level=None, selectable=False),
        }),
        "draft": AvoidanceClassification(section_key="s", sort_order=1, overrides={}),
    },
)


@pytest.mark.parametrize(
    ("requested", "expected"),
    [
        ({}, {"kind.a": "pass", "kind.b": "avoid"}),
        ({"kind.a": "exclude", "kind.b": "pass"}, {"kind.a": "exclude", "kind.b": "pass"}),
        ({"old.x": "avoid", "old.y": "exclude"}, {"kind.a": "exclude", "kind.b": "avoid"}),
        ({"kind.a": "pass", "old.x": "exclude"}, {"kind.a": "pass", "kind.b": "avoid"}),
        ({"kind.fixed": "exclude", "draft.a": "exclude", "gone.a": "exclude"}, {"kind.a": "pass", "kind.b": "avoid"}),
    ],
    ids=["省いた行は既定", "今の行の段", "前の鍵は強い方", "今の鍵が前の鍵に勝つ", "選べない・公開していない・知らない行は読まない"],
)
def test_requested_levels_are_aligned_to_the_current_rows(requested, expected):
    """区分を分け直す前に保存した条件の段を落とすと、避けたはずの道を通る。選べない行を読むと、画面に出ない段が探索に効く。"""
    assert resolve_road_avoidance(requested, DEFINITIONS) == expected
