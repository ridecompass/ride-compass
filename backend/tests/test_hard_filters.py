"""`domain/hard_filters.py`——いつも除く道・リクエストの避け方・勾配の上限から、探索で除く区間と割り増す区間を決める判断。

いつも除く道に当たるかを求めるSQLの式は、テスト用DBで道ごとに評価して見る（道は取込の入口`tests/source_ingest.py`から入れ、
読み手と同じ副問い合わせ`infrastructure/source_models.py: WAYS_SOURCE_SQL`で読む）。

ここで見ないもの:
- 避け方の段を行ごとに重ねる規則と、行が当たる道 → `test_road_avoidance.py`
- 上限が経路の組み立てから渡り、高速道路の除外と併せて効くこと → `test_route_generation_behavior.py`
"""

import numpy as np
import pytest
from sqlalchemy import text

from app.domain.attributes import EdgeMaterialArrays
from app.domain.evaluation import build_static_edge_score_matrix
from app.domain.hard_filters import HARD_FILTERS, ROUTE_FLAG_VALUE_SQL, compute_search_exclusion, route_flag_columns
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.road_avoidance import AVOIDABLE_ROWS, DEFAULT_ROAD_AVOIDANCE
from app.infrastructure.source_models import WAYS_SOURCE_SQL
from tests.source_ingest import ingest_records, way_record

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

    masks = compute_search_exclusion(matrix, DEFAULT_ROAD_AVOIDANCE, LIMIT)

    assert masks.excluded.tolist() == [excluded]


@pytest.mark.parametrize(
    ("level", "excluded", "avoided"),
    [("pass", False, False), ("avoid", False, True), ("exclude", True, False)],
)
def test_the_level_chosen_for_a_row_decides_whether_its_segments_are_excluded_or_surcharged(level, excluded, avoided):
    """「通らない」を選んでも国道を通る・「通る」を選んでも国道を避けると、選んだ避け方が探索に効かない。"""
    matrix = build_static_edge_score_matrix(edge(flags=frozenset({NATIONAL_ROAD})), {})

    masks = compute_search_exclusion(matrix, {**DEFAULT_ROAD_AVOIDANCE, NATIONAL_ROAD: level}, None)

    assert (masks.excluded.tolist(), masks.avoided.tolist()) == ([excluded], [avoided])


@pytest.mark.parametrize("name", sorted(HARD_FILTERS))
def test_a_road_cyclists_may_not_ride_is_excluded_whatever_level_is_chosen(name):
    """自転車が走ってはいけない道は、どの行を「通る」にしても経路に入らない。"""
    matrix = build_static_edge_score_matrix(edge(flags=frozenset({name})), {})

    masks = compute_search_exclusion(matrix, {key: "pass" for key in AVOIDABLE_ROWS}, None)

    assert masks.excluded.tolist() == [True]


@pytest.mark.asyncio(loop_scope="module")
@pytest.mark.parametrize(("tags", "matched"), [
    ({"highway": "motorway"}, ["motorway"]),
    ({"highway": "motorway_link"}, ["motorway"]),
    ({"highway": "trunk", "motorroad": "yes"}, ["motorway"]),
    ({"highway": "trunk", "motorroad": "no"}, []),
    ({"highway": "trunk"}, []),
    ({"highway": "secondary", "bicycle": "no"}, ["no_bicycle"]),
], ids=["高速道路", "高速道路の連絡路", "自動車専用道路", "自動車専用でない国道", "標識の無い国道", "自転車通行禁止"])
async def test_a_road_matches_only_the_kinds_cyclists_may_not_ride(road_graph_session, tags, matched):
    """自動車専用道路を通るルートを作ると走れず、標識の無い国道まで外すと遠回りになる。"""
    await ingest_records("osm_way", [way_record(1, [(139.70, 35.68), (139.701, 35.68)], [10, 11], tags)])
    names = sorted(HARD_FILTERS)
    columns = ", ".join(f"({ROUTE_FLAG_VALUE_SQL[name]})" for name in names)

    hits = (await road_graph_session.execute(text(f"SELECT {columns} FROM {WAYS_SOURCE_SQL} w"))).one()

    assert [name for name, hit in zip(names, hits, strict=True) if hit] == matched
