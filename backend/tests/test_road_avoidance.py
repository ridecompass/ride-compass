"""`domain/road_avoidance.py`——道のレイヤの凡例の行ごとの避け方と、区間がどの行に当たるか。

行が当たるかを求めるSQLの式は、テスト用DBで道ごとに評価して見る（道は取込の入口`tests/source_ingest.py`から入れ、
読み手と同じ副問い合わせ`infrastructure/source_models.py: WAYS_SOURCE_SQL`で読む）。

ここで見ないもの:
- 段の結果が除外・勾配の上限と合わさって探索から除く区間になること、選べない行の道（高速道路）を除くこと → `test_hard_filters.py`
- 割り増しが区間の費用に掛かること → `test_leg_costs.py`
"""

import pytest
from sqlalchemy import text

from app.domain.road_avoidance import AVOIDABLE_ROWS
from app.infrastructure.source_models import WAYS_SOURCE_SQL
from tests.source_ingest import ingest_records, way_record


@pytest.mark.asyncio(loop_scope="module")
@pytest.mark.parametrize(("highway", "row"), [
    ("trunk", "highway.trunk"), ("primary", "highway.primary"),
    ("secondary", "highway.secondary"), ("unclassified", "highway.unclassified"), ("residential", "highway.residential"),
    ("cycleway", "highway.cycleway"), ("path", "highway.footway"),
], ids=["国道", "主要地方道", "一般県道", "1車線の一般道", "住宅街の道", "自転車専用道", "山の小道"])
async def test_a_road_matches_only_the_row_of_its_kind(road_graph_session, highway, row):
    """国道を除いたつもりで国道を通る、県道まで除いて経路が遠回りになる、または歩道を除くと自転車専用道まで除かれる。"""
    await ingest_records("osm_way", [way_record(1, [(139.70, 35.68), (139.701, 35.68)], [10, 11], {"highway": highway})])
    keys = [key for key in AVOIDABLE_ROWS if key.startswith("highway.")]
    columns = ", ".join(f"({AVOIDABLE_ROWS[key].match_sql})" for key in keys)

    matched = (await road_graph_session.execute(text(f"SELECT {columns} FROM {WAYS_SOURCE_SQL} w"))).one()

    assert [key for key, hit in zip(keys, matched, strict=True) if hit] == [row]
