"""`domain/road_avoidance.py`——道のレイヤの凡例の行ごとの避け方と、区間がどの行に当たるか。

行が当たるかを求めるSQLの式は、テスト用DBで道ごとに評価して見る（道は取込の入口`tests/source_ingest.py`から入れ、
読み手と同じ副問い合わせ`infrastructure/source_models.py: WAYS_SOURCE_SQL`で読む）。

ここで見ないもの:
- 段の結果が除外・勾配の上限と合わさって探索から除く区間になること → `test_hard_filters.py`
- 割り増しが区間の費用に掛かること → `test_leg_costs.py`
"""

import numpy as np
import pytest
from sqlalchemy import text

from app.domain.road_avoidance import AVOIDABLE_ROWS, road_avoidance_masks
from app.infrastructure.source_models import WAYS_SOURCE_SQL
from tests.source_ingest import ingest_records, way_record

ARTERIAL = "highway.arterial"


def test_a_segment_on_rows_to_avoid_and_to_exclude_is_excluded():
    """弱い段を取ると、「通らない」を選んだ行の道を、別の行で「なるべく避ける」にしただけで通ってしまう。"""
    avoid_key, exclude_key = list(AVOIDABLE_ROWS)[:2]
    flags = {key: np.array([key in (avoid_key, exclude_key)]) for key in AVOIDABLE_ROWS}
    levels = {key: "pass" for key in AVOIDABLE_ROWS} | {avoid_key: "avoid", exclude_key: "exclude"}

    assert road_avoidance_masks(flags, levels, 1).excluded.tolist() == [True]


@pytest.mark.asyncio(loop_scope="module")
@pytest.mark.parametrize(("highway", "matches"), [("trunk", True), ("primary", True), ("secondary", False)],
                         ids=["国道", "主要地方道", "一般の県道"])
async def test_the_arterial_row_matches_national_and_major_roads_only(road_graph_session, highway, matches):
    """国道を除いたつもりで国道を通る、または県道まで除いて経路が遠回りになる。"""
    await ingest_records("osm_way", [way_record(1, [(139.70, 35.68), (139.701, 35.68)], [10, 11], {"highway": highway})])

    rows = await road_graph_session.execute(
        text(f"SELECT ({AVOIDABLE_ROWS[ARTERIAL].match_sql}) FROM {WAYS_SOURCE_SQL} w"))

    assert rows.scalars().all() == [matches]
