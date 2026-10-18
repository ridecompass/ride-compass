"""`domain/hard_filters.py`——リクエストの除外・避け方・勾配の上限から、探索で除く区間と割り増す区間を決める判断。

ここで見ないもの:
- 避け方の段を行ごとに重ねる規則と、行が当たる道 → `test_road_avoidance.py`
- 上限が経路の組み立てから渡り、高速道路の除外と併せて効くこと → `test_route_generation_behavior.py`
"""

import numpy as np
import pytest

from app.domain.attributes import EdgeMaterialArrays
from app.domain.evaluation import build_static_edge_score_matrix
from app.domain.hard_filters import DEFAULT_HARD_FILTERS, compute_search_exclusion, route_flag_columns
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.road_avoidance import DEFAULT_ROAD_AVOIDANCE

LIMIT = 8.0
NATIONAL_ROAD = "highway.trunk"


def edge(gradient_percent: float = 0.0, flags: frozenset[str] = frozenset()) -> EdgeMaterialArrays:
    """勾配と、立てた旗だけを持つ区間1本。"""
    nan = np.full(1, np.nan)
    route_flag_ids = route_flag_columns()
    return EdgeMaterialArrays(
        numeric_ids=(GRADIENT_PERCENT,), numeric_values=np.array([[gradient_percent]]),
        categorical_ids=(), categorical_columns=(),
        route_flag_ids=route_flag_ids, route_flags=np.array([[name in flags for name in route_flag_ids]]),
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

    masks = compute_search_exclusion(matrix, DEFAULT_HARD_FILTERS, DEFAULT_ROAD_AVOIDANCE, LIMIT)

    assert masks.excluded.tolist() == [excluded]


@pytest.mark.parametrize(
    ("level", "excluded", "avoided"),
    [("pass", False, False), ("avoid", False, True), ("exclude", True, False)],
)
def test_the_level_chosen_for_a_row_decides_whether_its_segments_are_excluded_or_surcharged(level, excluded, avoided):
    """「通らない」を選んでも国道を通る・「通る」を選んでも国道を避けると、選んだ避け方が探索に効かない。"""
    matrix = build_static_edge_score_matrix(edge(flags=frozenset({NATIONAL_ROAD})), {})

    masks = compute_search_exclusion(matrix, frozenset(), {**DEFAULT_ROAD_AVOIDANCE, NATIONAL_ROAD: level}, None)

    assert (masks.excluded.tolist(), masks.avoided.tolist()) == ([excluded], [avoided])

