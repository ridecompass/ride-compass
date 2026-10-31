"""0次ハードフィルタ（Hard Constraint）。

スコア計算には一切登場させず、ルーティンググラフから除外する判定だけを担う。
フィルタはどれもいつも効き、要求で切れない。判定（`compute_search_exclusion`）は
レジストリをループするため、フィルタを増やしても判定側は無変更で反映される。フィルタは道の区分（`domain/road_classes.py`）と
同じ形の条件で事実の列に当て、区分の宣言とは別に持つ。道の区分ごとの避け方（`domain/road_avoidance.py`）も同じ判定で、除く区間と
割り増す区間に分ける。
"""

from collections.abc import Mapping
from typing import TYPE_CHECKING, NamedTuple

import numpy as np

from app.domain.attributes import MaterialColumn
from app.domain.road_avoidance import AvoidanceLevel, RoadAvoidanceMasks, road_avoidance_masks
from app.domain.road_classes import Condition, ConditionTerm, conditions_match

if TYPE_CHECKING:
    # 行列を組む側（`domain/evaluation.py`）がこのファイルの判定を使うので、型だけを読む。
    from app.domain.evaluation import StaticEdgeScoreMatrix


class _HardFilter(NamedTuple):
    #: 画面に出す名前と説明。フィルタと同じ行に持つ——名前だけ別の表にすると、フィルタを
    #: 足したときに名前の無い行ができ、画面に内部名が出る。
    label: str
    description: str
    #: 該当する道（`domain/road_classes.py: conditions_match`の条件。どれかに当たる道）。
    conditions: list[Condition]


def _tag_is(fact_key: str, *values: str) -> Condition:
    return {fact_key: ConditionTerm(fact_values=list(values), negated=False, matches_absent=False)}


# 自転車が走ってはいけない道。どれもいつも除き、要求では入り切りを受けない。
HARD_FILTERS: dict[str, _HardFilter] = {
    "motorway": _HardFilter(
        "高速道路・自動車専用道路",
        "高速道路と、自動車専用の標識のある一般道（バイパス等）。自転車は通れないので、いつも経路から外します。",
        [_tag_is("highway", "motorway", "motorway_link"), _tag_is("motorroad", "yes")],
    ),
    "no_bicycle": _HardFilter(
        "自転車通行禁止",
        "自転車の通行が禁止された道。いつも経路から外します。",
        [_tag_is("bicycle", "no")],
    ),
}


def hard_filtered(columns: Mapping[str, MaterialColumn], n: int) -> np.ndarray:
    """区間ごとに、0次ハードフィルタのどれかに当たるか。"""
    return conditions_match([c for spec in HARD_FILTERS.values() for c in spec.conditions], columns, n)


def compute_routable_nodes(
    edge_from: np.ndarray,
    edge_to: np.ndarray,
    hard_filter_excluded: np.ndarray,
    node_count: int,
) -> np.ndarray:
    """0次ハードフィルタで除外されなかった区間が1本以上あるノード（ノード番号順の真偽）。

    探索用グラフ（`domain/search_graph.py: LazyRoadGraph`）はHard Constraintをグラフ構造では
    なくコスト（`math.inf`）で表現するため、「実際に経路探索可能なNode」はここで別途
    求める必要がある。

    `hard_filter_excluded`は呼び出し元が探索コストを`inf`にするのに使うのと同じ配列を
    そのまま渡す想定で、`edge_from`・`edge_to`と**同じ行順・同じ長さ**。
    """
    kept = ~np.asarray(hard_filter_excluded, dtype=bool)
    routable = np.zeros(node_count, dtype=bool)
    routable[np.asarray(edge_from)[kept]] = True
    routable[np.asarray(edge_to)[kept]] = True
    return routable


def compute_search_exclusion(
    score_matrix: "StaticEdgeScoreMatrix",
    road_avoidance: Mapping[str, AvoidanceLevel],
) -> RoadAvoidanceMasks:
    """静的スコア行列が持つ0次ハードフィルタ・区分の列から、リクエスト時点の`road_avoidance`を反映した、
    探索から除く区間と割り増す区間を求める。"""
    rows = road_avoidance_masks(score_matrix.road_classes, road_avoidance, len(score_matrix.distance_m))
    return RoadAvoidanceMasks(excluded=rows.excluded | score_matrix.hard_filtered, avoided=rows.avoided)
