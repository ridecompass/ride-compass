"""道1本の性質（通行方向・上下線分離）を`way_directions`へ書く。区間粒度の対応物を持たない値。

**通行方向はここでタグから決める**。引き当ての表は`domain/traffic.py`が持ち、
このバッチはそれをSQLへ渡すだけで、タグを読むために行を取り出さない。

**全部の道（`road_ways`）が行を持つ**——探索は区間の道の通行方向を読んで逆向きの枝を作るかを決め、行の無い道は
通行方向を持たない。外部キーは子の行の有無を縛れないので、段の最後に数を比べて止める。
"""

import logging
import time

import asyncpg

from app.batch.common import affected_rows
from app.domain import divided_carriageway as dc
from app.infrastructure.source_models import WAYS_SOURCE_SQL
from app.domain.traffic import direction_sql

logger = logging.getLogger("ridecompass.derive_way_directions")


#: 引き当てる側が期待する形（`id`・`tags`）へ生データを写す。
_SOURCE_WAYS = f"SELECT osm_way_id AS id, tags FROM {WAYS_SOURCE_SQL} w"

#: 道ごとの通行方向と、上下線の判定に要るものを1つの表へまとめ、索引を張る。相方探しは自分自身を何度も引くため、
#: `source_features`の全ソースが載る親表を毎回たどらせない。
_WAY_FACTS = f"""
CREATE TEMP TABLE _way_facts ON COMMIT DROP AS
SELECT w.osm_way_id, w.geom,
       d.direction,
       w.highway,
       {dc.facts_sql("w", "d.direction")}
FROM road_ways r
JOIN ({direction_sql(_SOURCE_WAYS)}) d ON d.id = r.osm_way_id
JOIN {WAYS_SOURCE_SQL} w ON w.osm_way_id = r.osm_way_id
"""

_INSERT = f"""
INSERT INTO way_directions (osm_way_id, direction, divided)
SELECT t.osm_way_id, t.direction, {dc.divided_sql("t", "_way_facts")}
FROM _way_facts t
"""


async def derive(conn: asyncpg.Connection) -> None:
    async with conn.transaction():
        await conn.execute("TRUNCATE way_directions")
        await conn.execute(_WAY_FACTS)
        await conn.execute("CREATE INDEX ON _way_facts USING GIST (geom)")
        await conn.execute("ANALYZE _way_facts")
        started = time.perf_counter()
        count = affected_rows(await conn.execute(_INSERT))
        divided = await conn.fetchval("SELECT count(*) FROM way_directions WHERE divided")
        logger.info("通行方向を決めた: %d本（上下線の片側 %d本） / %.1f秒", count, divided, time.perf_counter() - started)
        ways = await conn.fetchval("SELECT count(*) FROM road_ways")
        if count != ways:
            raise RuntimeError(f"通行方向を持たない道がある: 道 {ways}本に対して通行方向 {count}本")
        await conn.execute("ANALYZE way_directions")
