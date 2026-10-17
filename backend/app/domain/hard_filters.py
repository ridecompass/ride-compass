"""0次ハードフィルタ（Hard Constraint）。

スコア計算には一切登場させず、ルーティンググラフから除外する判定だけを担う。
フィルタごとに名前を付け、レシピ単位で個別に有効/無効を選べる。判定
（`compute_search_exclusion`）はレジストリをループするため、フィルタを1つ
増やしても判定側は無変更で反映される。道のレイヤの行ごとの避け方（`domain/road_avoidance.py`）も
同じ旗の列で受け、同じ判定で除く区間と割り増す区間に分ける。
"""

from collections.abc import Mapping
from typing import NamedTuple

import numpy as np

from app.domain.evaluation import StaticEdgeScoreMatrix
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.material_sql import BICYCLE_NORMALIZED_SQL, HIGHWAY_SQL, sql_literals
from app.domain.road_avoidance import AVOIDABLE_ROWS, AvoidanceLevel, RoadAvoidanceMasks, road_avoidance_masks


class HighwayHardFilter(NamedTuple):
    #: 画面に出す名前。フィルタと同じ行に持つ——名前だけ別の表にすると、フィルタを
    #: 足したときに名前の無い行ができ、画面に内部名が出る。
    label: str
    highway_types: frozenset[str]


class TagHardFilter(NamedTuple):
    label: str
    #: 「該当するか」をSQLで表す式。
    predicate_sql: str


# highway種別で決まるフィルタ。ここへ1行足すだけで、名前の集合も判定式の列も画面の
# 名前も増える。
HARD_FILTER_HIGHWAY_TYPES: dict[str, HighwayHardFilter] = {
    "motorway": HighwayHardFilter("高速道路", frozenset({"motorway", "motorway_link"})),
}

# highwayでは決まらない、タグ由来のフィルタ。足すならここへ1エントリ書くだけでよい。
HARD_FILTER_TAG_PREDICATE_SQL: dict[str, TagHardFilter] = {
    "no_bicycle": TagHardFilter("自転車通行禁止", f"COALESCE({BICYCLE_NORMALIZED_SQL} = 'no', false)"),
}

#: フィルタ名→画面に出す名前。上の2つの宣言から導く。
HARD_FILTER_LABELS: dict[str, str] = {
    **{name: spec.label for name, spec in HARD_FILTER_HIGHWAY_TYPES.items()},
    **{name: spec.label for name, spec in HARD_FILTER_TAG_PREDICATE_SQL.items()},
}

# APIの`hard_filters`が受け付けるキー集合の正本。**別の場所で組み立て直さないこと**
# ——キー完全一致で検証するため、片方だけ増えた瞬間にすべてのルート生成が422になる。
HARD_FILTER_NAMES: frozenset[str] = frozenset({*HARD_FILTER_TAG_PREDICATE_SQL, *HARD_FILTER_HIGHWAY_TYPES})

# 画面の既定は全フィルタを有効にする。「受け付けるキー」と「既定でONのキー」は別の
# 概念で、たまたま一致している。
DEFAULT_HARD_FILTERS: frozenset[str] = HARD_FILTER_NAMES


def _highway_is_one_of_sql(highway_types: frozenset[str]) -> str:
    return f"{HIGHWAY_SQL} IN ({sql_literals(sorted(highway_types))})"


# フィルタ名→「その区間が該当するか」をSQLで表す式。材料を読むクエリがこの名前のまま
# 列として受け取る。**フィルタごとに専用の列を作らない**——上の2つのレジストリから導く
# ため、`HARD_FILTER_NAMES`とキー集合がずれようがない。
HARD_FILTER_VALUE_SQL: dict[str, str] = {
    **{name: _highway_is_one_of_sql(spec.highway_types) for name, spec in HARD_FILTER_HIGHWAY_TYPES.items()},
    **{name: spec.predicate_sql for name, spec in HARD_FILTER_TAG_PREDICATE_SQL.items()},
}


# 旗の名前→「その区間が当たるか」をSQLで表す式。0次フィルタと避け方を選べる行（`domain/road_avoidance.py:
# AVOIDABLE_ROWS`）を、道路網の同じ旗の列に持つ。名前が重なると片方の旗が黙って消えるので、import時に落とす。
_SHARED_FLAG_NAMES = sorted(HARD_FILTER_VALUE_SQL.keys() & AVOIDABLE_ROWS.keys())
if _SHARED_FLAG_NAMES:
    raise ValueError(f"0次フィルタと避け方の行の名前が重なっている: {_SHARED_FLAG_NAMES}")
ROUTE_FLAG_VALUE_SQL: dict[str, str] = {
    **HARD_FILTER_VALUE_SQL,
    **{key: row.match_sql for key, row in AVOIDABLE_ROWS.items()},
}


def route_flag_columns() -> tuple[str, ...]:
    """探索の旗の列の並び。組み立てる側と読む側が別々に並べると意味がずれる。"""
    return tuple(sorted(ROUTE_FLAG_VALUE_SQL))


def compute_routable_nodes(
    edge_from: np.ndarray,
    edge_to: np.ndarray,
    hard_filter_excluded: np.ndarray,
    node_count: int,
) -> np.ndarray:
    """0次ハードフィルタで除外されなかった区間が1本以上あるノード（ノード番号順の真偽）。

    探索用グラフ（`domain/routing.py: LazyRoadGraph`）はHard Constraintをグラフ構造では
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
    score_matrix: StaticEdgeScoreMatrix,
    hard_filters: frozenset[str],
    road_avoidance: Mapping[str, AvoidanceLevel],
    max_average_grade_percent: float | None,
) -> RoadAvoidanceMasks:
    """静的スコア行列が持つ旗と勾配の列から、リクエスト時点の`hard_filters`/`road_avoidance`/
    `max_average_grade_percent`を反映した、探索から除く区間と割り増す区間を求める。

    `score_matrix.route_flags`は`ROUTE_FLAG_VALUE_SQL`の旗の名前→該当フラグ配列で、**キー集合の
    完全一致を要求する**——欠けた旗は黙って無効になり、高速道路や`bicycle=no`の道が
    そのまま候補へ入る。フィルタや行を1つ増やしてもこの関数は変わらない。
    """
    route_flags = score_matrix.route_flags
    if route_flags.keys() != ROUTE_FLAG_VALUE_SQL.keys():
        raise ValueError(
            f"探索の旗の列が宣言と違います 不足={sorted(ROUTE_FLAG_VALUE_SQL.keys() - route_flags.keys())} "
            f"未知={sorted(route_flags.keys() - ROUTE_FLAG_VALUE_SQL.keys())}"
        )
    rows = road_avoidance_masks(route_flags, road_avoidance, len(score_matrix.distance_m))
    excluded = rows.excluded.copy()
    for filter_name in HARD_FILTER_NAMES & hard_filters:
        excluded |= route_flags[filter_name]
    # 勾配の〇次ハードフィルタ（NaNとの比較は常にFalseになるため、勾配不明のEdgeへは
    # 適用されない）。
    if max_average_grade_percent is not None:
        with np.errstate(invalid="ignore"):
            excluded |= np.abs(score_matrix.material_column(GRADIENT_PERCENT)) > max_average_grade_percent
    return RoadAvoidanceMasks(excluded=excluded, avoided=rows.avoided)
