"""`domain/hard_filters.py`——いつも除く道・リクエストの避け方・勾配の上限から、探索で除く区間と割り増す区間を決める判断。

ここで見ないもの:
- 避け方の段を、今の区分の行へ揃える規則 → `test_road_avoidance.py`
- 区分に道を振り分ける式 → `test_road_classes.py`
- 上限が経路の組み立てから渡り、高速道路の除外と併せて効くこと → `test_route_generation_behavior.py`
"""

import numpy as np
import pytest

from app.domain.attributes import CategoricalColumn, EdgeMaterialArrays
from app.domain.evaluation import build_static_edge_score_matrix
from app.domain.hard_filters import compute_search_exclusion
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.road_classes import class_material_id

LIMIT = 8.0


def edge(gradient_percent: float = 0.0, facts: dict[str, str] | None = None) -> EdgeMaterialArrays:
    """勾配と、分類の事実（材料のid→値。区分の列もここへ書く）だけを持つ区間1本。"""
    nan = np.full(1, np.nan)
    facts = facts or {}
    return EdgeMaterialArrays(
        numeric_ids=(GRADIENT_PERCENT,), numeric_values=np.array([[gradient_percent]]),
        categorical_ids=tuple(facts), categorical_columns=tuple(CategoricalColumn.encode([v]) for v in facts.values()),
        distance_m=np.full(1, 100.0), bearing_deg=nan, mid_lat=nan, mid_lon=nan,
        start_elevation_m=nan, end_elevation_m=nan,
        elevation_gain_m=nan, elevation_loss_m=nan,
    )


@pytest.mark.parametrize(
    ("gradient_percent", "excluded"),
    [
        (LIMIT, False),
        (LIMIT + 0.1, True),
        (-(LIMIT + 0.1), True),
        (np.nan, False),
    ],
    ids=["上限ちょうど", "上限を超える登り", "上限を超える下り", "勾配が不明"],
)
def test_a_segment_steeper_than_the_requested_limit_is_excluded(gradient_percent, excluded):
    """上限ちょうどの坂まで走れる。外し損なうと上限を指定しても急坂を通り、外しすぎると上限の坂だけの地域で経路が作れない。"""
    matrix = build_static_edge_score_matrix(edge(gradient_percent), {})

    masks = compute_search_exclusion(matrix, {}, LIMIT)

    assert masks.excluded.tolist() == [excluded]


@pytest.mark.parametrize(
    ("level", "excluded", "avoided"),
    [("pass", False, False), ("avoid", False, True), ("exclude", True, False)],
)
def test_the_level_chosen_for_a_row_decides_whether_its_segments_are_excluded_or_surcharged(level, excluded, avoided):
    """「通らない」を選んでも国道を通る・「通る」を選んでも国道を避けると、選んだ避け方が探索に効かない。"""
    matrix = build_static_edge_score_matrix(edge(facts={class_material_id("kind"): "national"}), {})

    masks = compute_search_exclusion(matrix, {"kind.national": level, "kind.local": "exclude", "other.national": "exclude"}, None)

    assert (masks.excluded.tolist(), masks.avoided.tolist()) == ([excluded], [avoided])


@pytest.mark.parametrize(("tags", "excluded"), [
    ({"highway": "motorway"}, True),
    ({"highway": "motorway_link"}, True),
    ({"highway": "trunk", "motorroad": "yes"}, True),
    ({"highway": "trunk", "motorroad": "no"}, False),
    ({"highway": "trunk"}, False),
    ({"highway": "secondary", "bicycle": "no"}, True),
], ids=["高速道路", "高速道路の連絡路", "自動車専用道路", "自動車専用でない国道", "標識の無い国道", "自転車通行禁止"])
def test_only_the_roads_cyclists_may_not_ride_are_always_excluded(tags, excluded):
    """自動車専用道路を通るルートを作ると走れず、標識の無い国道まで外すと遠回りになる。"""
    matrix = build_static_edge_score_matrix(edge(facts=tags), {})

    assert compute_search_exclusion(matrix, {}, None).excluded.tolist() == [excluded]
