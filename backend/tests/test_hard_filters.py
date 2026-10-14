"""`domain/hard_filters.py`——リクエストの勾配の上限で区間を0次フィルタから外す判断。

ここで見ないもの:
- 上限が経路の組み立てから渡り、高速道路の除外と併せて効くこと → `test_route_generation_behavior.py`
"""

import numpy as np
import pytest

from app.domain.attributes import EdgeMaterialArrays
from app.domain.evaluation import build_static_edge_score_matrix
from app.domain.hard_filters import DEFAULT_HARD_FILTERS, compute_hard_filter_excluded, hard_filter_columns
from app.domain.material_catalog import GRADIENT_PERCENT

LIMIT = 8.0


def graded(gradient_percent: float) -> EdgeMaterialArrays:
    """勾配だけを持ち、どの0次フィルタのフラグも立たない区間1本。"""
    nan = np.full(1, np.nan)
    hard_filter_ids = hard_filter_columns()
    return EdgeMaterialArrays(
        numeric_ids=(GRADIENT_PERCENT,), numeric_values=np.array([[gradient_percent]]),
        categorical_ids=(), categorical_columns=(),
        hard_filter_ids=hard_filter_ids, hard_filter_flags=np.zeros((1, len(hard_filter_ids)), dtype=bool),
        distance_m=np.full(1, 100.0), bearing_deg=nan, mid_lat=nan, mid_lon=nan,
        elevation_present=np.zeros(1, dtype=bool),
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
    matrix = build_static_edge_score_matrix(graded(gradient_percent), {})

    assert compute_hard_filter_excluded(matrix, DEFAULT_HARD_FILTERS, LIMIT).tolist() == [excluded]
