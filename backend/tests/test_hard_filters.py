"""`domain/hard_filters.py`——いつも除く道・リクエストの避け方から、探索で除く区間と割り増す区間を決める判断。

ここで見ないもの:
- 避け方の段を、今の区分の行へ揃える規則 → `test_road_avoidance.py`
- 区分に道を振り分ける式 → `test_road_classes.py`
- いつも除く道が経路の組み立てから効くこと → `test_route_generation_behavior.py`
"""

import numpy as np
import pytest

from app.domain.attributes import CategoricalColumn, EdgeMaterialColumns
from app.domain.evaluation import build_static_edge_score_matrix
from app.domain.hard_filters import compute_search_exclusion
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.road_classes import class_material_id

def edge(facts: dict[str, str] | None = None) -> EdgeMaterialColumns:
    """平らな勾配と、分類の事実（材料のid→値。区分の列もここへ書く）だけを持つ区間1本。"""
    nan = np.full(1, np.nan)
    facts = facts or {}
    return EdgeMaterialColumns(
        columns={GRADIENT_PERCENT: np.zeros(1), **{m: CategoricalColumn.encode([v]) for m, v in facts.items()}},
        distance_m=np.full(1, 100.0), bearing_deg=nan, mid_lat=nan, mid_lon=nan,
    )


@pytest.mark.parametrize(
    ("level", "excluded", "avoided"),
    [("pass", False, False), ("avoid", False, True), ("exclude", True, False)],
)
def test_the_level_chosen_for_a_row_decides_whether_its_segments_are_excluded_or_surcharged(level, excluded, avoided):
    """「通らない」を選んでも国道を通る・「通る」を選んでも国道を避けると、選んだ避け方が探索に効かない。"""
    matrix, _ = build_static_edge_score_matrix(edge(facts={class_material_id("kind"): "national"}), {}, {})

    masks = compute_search_exclusion(matrix, {"kind.national": level, "kind.local": "exclude", "other.national": "exclude"})

    assert (masks.excluded.tolist(), masks.avoided.tolist()) == ([excluded], [avoided])


@pytest.mark.parametrize(("tags", "excluded"), [
    ({"highway": "motorway"}, True),
    ({"highway": "trunk", "motorroad": "yes"}, True),
    ({"highway": "trunk"}, False),
    ({"highway": "secondary", "bicycle": "no"}, True),
], ids=["高速道路", "自動車専用道路", "標識の無い国道", "自転車通行禁止"])
def test_only_the_roads_cyclists_may_not_ride_are_always_excluded(tags, excluded):
    """自動車専用道路を通るルートを作ると走れず、標識の無い国道まで外すと遠回りになる。"""
    matrix, _ = build_static_edge_score_matrix(edge(facts=tags), {}, {})

    assert compute_search_exclusion(matrix, {}).excluded.tolist() == [excluded]
