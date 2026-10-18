"""区間と道に付く自転車の事故の数（`edge_accidents`・`way_accidents`）を埋める。

事故は1件ずつ、帰属の距離の内で最も近い区間へ付ける。区間の形は場所を引くためだけに読み、道のタグも
区間の長さも読まない。道の値は区間の和から導く——区間と道で数え方が違うと、地図と評価で値が食い違う。
"""

import logging
import time

import asyncpg

from app.domain.accident import (
    ACCIDENT_FATAL_WEIGHT,
    ACCIDENT_MATCH_MAX_DISTANCE_M,
    BICYCLE_SQL,
    FATAL_SQL,
)
from app.domain.geo import degrees_covering_m
from app.infrastructure.source_models import ACCIDENTS_SOURCE_SQL

logger = logging.getLogger("ridecompass.derive_accidents")

#: 全区間の行を0で作ってから数える。事故が1つも無い区間は0のまま残る。
_EDGE_ROWS = """
INSERT INTO edge_accidents (osm_way_id, segment_index, accident_count)
SELECT osm_way_id, segment_index, 0 FROM road_edges
"""

#: 自転車の関わった事故を、帰属の距離の内で最も近い区間へ1件だけ付ける。鍵の2列は同じ1回の
#: 探索から取る——別々に探すと、等距離のタイで実在しない組を指しうる。
_EDGE_ACCIDENTS = f"""
WITH nearest AS (
    SELECT CASE WHEN {FATAL_SQL} THEN $1 ELSE 1.0 END AS weight, n.osm_way_id, n.segment_index
    FROM {ACCIDENTS_SOURCE_SQL} a
    CROSS JOIN LATERAL (
        SELECT e.osm_way_id, e.segment_index FROM road_edges e
        WHERE e.geom && ST_Expand(a.geom, $2)
          AND ST_DWithin(e.geom::geography, a.geom::geography, $3)
        ORDER BY ST_Distance(e.geom::geography, a.geom::geography), e.osm_way_id, e.segment_index
        LIMIT 1) n
    WHERE {BICYCLE_SQL}
)
UPDATE edge_accidents m SET accident_count = s.total
FROM (
    SELECT osm_way_id, segment_index, sum(weight) AS total
    FROM nearest GROUP BY osm_way_id, segment_index
) s
WHERE s.osm_way_id = m.osm_way_id AND s.segment_index = m.segment_index
"""

#: どの道も区間を持つ（`derive_topology`は区間のある道だけを入れる）ので、全部の道が行を持つ。
_WAY_FROM_EDGES = """
INSERT INTO way_accidents (osm_way_id, accident_count)
SELECT osm_way_id, sum(accident_count) FROM edge_accidents GROUP BY osm_way_id
"""


async def derive(conn: asyncpg.Connection) -> None:
    started = time.perf_counter()

    # 事故の行と、それを入れた取込を同じ時点から読む（間に取込が入れ替えても食い違わない）。
    async with conn.transaction(isolation="repeatable_read"):
        await conn.execute("TRUNCATE edge_accidents, way_accidents")
        await conn.execute(_EDGE_ROWS)
        await conn.execute("ANALYZE edge_accidents")
        await conn.execute(_EDGE_ACCIDENTS, ACCIDENT_FATAL_WEIGHT, degrees_covering_m(ACCIDENT_MATCH_MAX_DISTANCE_M),
                           ACCIDENT_MATCH_MAX_DISTANCE_M)
        await conn.execute(_WAY_FROM_EDGES)

    logger.info("事故の数を埋めた / %.1f秒", time.perf_counter() - started)
