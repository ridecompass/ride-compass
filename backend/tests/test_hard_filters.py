"""`domain/hard_filters.py`——いつも除く道・リクエストの避け方から、探索で除く区間と割り増す区間を決める判断。

ここで見ないもの:
- 避け方の段を、今の区分の行へ揃える規則 → `test_road_avoidance.py`
- 区分に道を振り分ける式 → `test_road_classes.py`
- いつも除く道が経路の組み立てから効くこと → `test_route_generation_behavior.py`
"""

import numpy as np
import pytest

from app.domain.attributes import CategoricalColumn, EdgeMaterialColumns
from app.domain.search_materials import build_search_materials
from app.domain.hard_filters import compute_search_exclusion
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.road_classes import EMPTY_ROAD_CLASSES, class_material_id
from app.domain.road_avoidance import level_multipliers
from app.domain.wind_height import WindHeights
from tests.profile_fixture import grade_spans
from tests.tuning_fixture import TUNED


def edge(facts: dict[str, str] | None = None) -> EdgeMaterialColumns:
    """平らな勾配と、分類の事実（材料のid→値。区分の列もここへ書く）だけを持つ区間1本。"""
    nan = np.full(1, np.nan)
    facts = facts or {}
    return EdgeMaterialColumns(
        columns={GRADIENT_PERCENT: np.zeros(1), **{m: CategoricalColumn.encode([v]) for m, v in facts.items()}},
        distance_m=np.full(1, 100.0), bearing_deg=nan, mid_lat=nan, mid_lon=nan,
        elevation_spans=grade_spans(np.zeros(1), np.full(1, 100.0)),
        wind_heights=WindHeights(lambda _grid: np.ones((1, 2)), np.zeros(1, dtype=np.int64)),
    )


MULTIPLIERS = level_multipliers(TUNED)


@pytest.mark.parametrize(
    ("levels", "excluded", "scaled_by", "deciding"),
    [
        ({"kind.national": "pass"}, False, "pass", None),
        ({"kind.national": "avoid"}, False, "avoid", ("kind.national", "avoid")),
        ({"kind.national": "exclude"}, True, "pass", ("kind.national", "exclude")),
        # 1つの道が2つの行に当たれば倍率の大きい方: 「通る」は何も指定していない扱いで、避ける側は好む側より大きい。
        ({"kind.national": "pass", "surface.gravel": "prefer"}, False, "prefer", ("surface.gravel", "prefer")),
        ({"kind.national": "avoid", "surface.gravel": "prefer"}, False, "avoid", ("kind.national", "avoid")),
        ({"kind.national": "slight_prefer", "surface.gravel": "prefer"}, False, "slight_prefer",
         ("kind.national", "slight_prefer")),
        # 同じ段の行がいくつも当たれば、先の行が決めた行になる。
        ({"kind.national": "avoid", "surface.gravel": "avoid"}, False, "avoid", ("kind.national", "avoid")),
    ],
)
def test_the_largest_multiplier_of_the_rows_of_a_road_decides_how_its_segments_are_searched(levels, excluded, scaled_by, deciding):
    """「通らない」を選んでも国道を通る・「通る」を選んでも国道を避けると、選んだ避け方が探索に効かない。"""
    matrix = build_search_materials(
        edge(facts={class_material_id("kind"): "national", class_material_id("surface"): "gravel"}), {}, (),
        EMPTY_ROAD_CLASSES)

    masks = compute_search_exclusion(matrix, {**levels, "kind.local": "exclude", "other.national": "exclude"}, MULTIPLIERS)

    assert (masks.excluded.tolist(), masks.cost_scale.tolist()) == ([excluded], [MULTIPLIERS[scaled_by]])
    # 区間の小窓が、ルートの脇の線の理由として出す行。
    assert masks.deciding_at(np.array([0])) == [deciding]


@pytest.mark.parametrize(("tags", "excluded"), [
    ({"highway": "motorway"}, True),
    ({"highway": "trunk", "motorroad": "yes"}, True),
    ({"highway": "trunk"}, False),
    ({"highway": "secondary", "bicycle": "no"}, True),
], ids=["高速道路", "自動車専用道路", "標識の無い国道", "自転車通行禁止"])
def test_only_the_roads_cyclists_may_not_ride_are_always_excluded(tags, excluded):
    """自動車専用道路を通るルートを作ると走れず、標識の無い国道まで外すと遠回りになる。"""
    matrix = build_search_materials(edge(facts=tags), {}, (), EMPTY_ROAD_CLASSES)

    assert compute_search_exclusion(matrix, {}, MULTIPLIERS).excluded.tolist() == [excluded]
