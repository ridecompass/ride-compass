"""道1本の性質（通行方向・上下線分離）を`way_directions`へ書く。区間粒度の対応物を持たない値。

**通行方向はタグと JARTIC の一方通行の規制から決める**。タグの引き当ての表と式、規制を効かせる式は`domain/traffic.py`が持ち、
このバッチはそれを差し込んだSQL文を組むだけで、タグを読むために行を取り出さない。一方通行の規制は、歩行者用道路と同じ当て方
（`batch/derive_traffic_regulations.py: EDGES_HIT_SQL`）で区間へ当て、当たった区間の長さが道の長さの割合（区間へ当てる割合と
同じ較正値）以上の道にだけ効かせる。道に当たった規制のどれかが自転車も対象なら、自転車も対象とみなす（逆走させない側に倒す）。
自転車を除く規制は、線の同じ所に別の道も並んで当たるなら効かせない（どの道の規制か決められないときも、逆走させない側に倒す）。

**上下線分離の判定は、規制を効かせる前のタグの通行方向で行う**——規制の当て違いで、上下線の判定を変えない。

**全部の道（`road_ways`）が行を持つ**——探索は区間の道の通行方向を読んで逆向きの枝を作るかを決め、行の無い道は
通行方向を持たない。
"""

import logging
import time

import asyncpg

from app.batch.common import affected_rows
from app.batch.derive_traffic_regulations import EDGES_HIT_SQL, READ_REGULATIONS_SQL, place_regulations
from app.domain import divided_carriageway as dc
from app.domain.traffic_regulation import excepts_bicycles
from app.infrastructure.source_models import ONE_WAY_KIND, WAYS_SOURCE_SQL, regulation_slots
from app.domain.traffic import (
    DIRECTION_RULES,
    VEHICLE_DIRECTION_RULES,
    direction_or_default_sql,
    first_rule_sql,
    regulated_direction_sql,
    rule_match_sql,
)

logger = logging.getLogger("ridecompass.derive_way_directions")


def direction_sql(source: str, rules: tuple[tuple[str, str, str, int], ...] = DIRECTION_RULES) -> str:
    """`source`（`id`・`tags`を返す関係）の各行へ、表`rules`で通行方向を付ける。どれにも当たらない行も返る——道は必ずどちらかに通れる。"""
    return f"""
WITH src AS ({source}),
matched AS ({rule_match_sql("src", rules)}),
best AS ({first_rule_sql("matched")})
SELECT s.id, {direction_or_default_sql("b.result")} AS direction
FROM src s LEFT JOIN best b ON b.id = s.id
"""


#: 引き当てる側が期待する形（`id`・`tags`）へ生データを写す。
_SOURCE_WAYS = f"SELECT osm_way_id AS id, tags FROM {WAYS_SOURCE_SQL} w"

#: 一方通行の規制（`_oneway_regulations`）の場所が当たる区間から、道ごとに、効かせる規制が自転車も対象か。自転車を除く規制は、
#: 線の同じ所（道の区間を線へ写した範囲が重なる所）に別の道も当たるなら、どの道の規制か決められないので、その道へは効かせない
#: （`shared`）。効かせる規制の区間の長さが道の長さの`$1`の割合に届かない道は行を持たない（道の一部にだけ当たる規制で、
#: 道全体の向きを決めない）。`$2`は区間へ当てる向きの差の上限。
_WAY_REGULATIONS = f"""
CREATE TEMP TABLE _way_regulations ON COMMIT DROP AS
WITH hit AS ({EDGES_HIT_SQL}),
spans AS (
  SELECT h.osm_way_id, h.regulation_id,
         min(least(ST_LineLocatePoint(p.line, ST_StartPoint(e.geom)), ST_LineLocatePoint(p.line, ST_EndPoint(e.geom)))) AS lo,
         max(greatest(ST_LineLocatePoint(p.line, ST_StartPoint(e.geom)), ST_LineLocatePoint(p.line, ST_EndPoint(e.geom)))) AS hi
  FROM hit h
  JOIN road_edges e USING (osm_way_id, segment_index)
  JOIN _regulation_places p USING (regulation_id)
  WHERE p.line IS NOT NULL
  GROUP BY h.osm_way_id, h.regulation_id),
shared AS (
  SELECT DISTINCT a.osm_way_id, a.regulation_id
  FROM spans a JOIN spans b
    ON b.regulation_id = a.regulation_id AND b.osm_way_id <> a.osm_way_id AND b.lo < a.hi AND b.hi > a.lo),
applied AS (
  SELECT h.osm_way_id, h.segment_index, r.excepts_bicycles
  FROM hit h
  JOIN _oneway_regulations r USING (regulation_id)
  WHERE NOT r.excepts_bicycles
     OR NOT EXISTS (SELECT 1 FROM shared s WHERE s.osm_way_id = h.osm_way_id AND s.regulation_id = h.regulation_id)),
covered AS (
  SELECT e.osm_way_id, sum(e.distance_m) AS length_m
  FROM road_edges e
  WHERE (e.osm_way_id, e.segment_index) IN (SELECT osm_way_id, segment_index FROM applied)
  GROUP BY e.osm_way_id),
way_length AS (
  SELECT osm_way_id, sum(distance_m) AS length_m FROM road_edges
  WHERE osm_way_id IN (SELECT osm_way_id FROM covered) GROUP BY osm_way_id)
SELECT a.osm_way_id, bool_or(NOT a.excepts_bicycles) AS bicycle_regulated
FROM applied a
JOIN covered c USING (osm_way_id)
JOIN way_length l USING (osm_way_id)
WHERE c.length_m >= $1 * l.length_m
GROUP BY a.osm_way_id
"""

#: 道ごとの通行方向と、上下線の判定に要るものを1つの表へまとめ、索引を張る。相方探しは自分自身を何度も引くため、
#: `source_features`の全ソースが載る親表を毎回たどらせない。`direction`はタグの通行方向（上下線の判定が読む）、
#: `travel_direction`は規制を効かせた向き。
_WAY_FACTS = f"""
CREATE TEMP TABLE _way_facts ON COMMIT DROP AS
SELECT w.osm_way_id, w.geom,
       d.direction,
       {regulated_direction_sql("d.direction", "v.direction", "g.bicycle_regulated")} AS travel_direction,
       w.highway,
       {dc.facts_sql("w", "d.direction")}
FROM road_ways r
JOIN ({direction_sql(_SOURCE_WAYS)}) d ON d.id = r.osm_way_id
JOIN ({direction_sql(_SOURCE_WAYS, VEHICLE_DIRECTION_RULES)}) v ON v.id = r.osm_way_id
LEFT JOIN _way_regulations g ON g.osm_way_id = r.osm_way_id
JOIN {WAYS_SOURCE_SQL} w ON w.osm_way_id = r.osm_way_id
"""

def _insert_sql(named_gap_m: float, geometric_gap_m: float, bearing_tolerance_deg: float) -> str:
    return f"""
INSERT INTO way_directions (osm_way_id, direction, divided)
SELECT t.osm_way_id, t.travel_direction,
       {dc.divided_sql("t", "_way_facts", named_gap_m, geometric_gap_m, bearing_tolerance_deg)}
FROM _way_facts t
"""


async def derive(conn: asyncpg.Connection, *, named_gap_m: float, geometric_gap_m: float,
                 bearing_tolerance_deg: float, line_half_width_m: float, edge_share: float, max_angle_deg: float) -> None:
    """上下線の相方は、同じ路線番号・名前なら`named_gap_m`、形だけなら`geometric_gap_m`以内で、向きの差が
    `bearing_tolerance_deg`以内の逆向きの一方通行（較正値`divided.*`）。一方通行の規制は、線から`line_half_width_m`までの帯の
    中に長さの`edge_share`以上があり、線との向きの差が`max_angle_deg`以下の区間へ当てる（較正値`traffic_regulation.*`）。"""
    regulations = [(row["regulation_id"], excepts_bicycles(regulation_slots(row["slots"])))
                   for row in await conn.fetch(READ_REGULATIONS_SQL, ONE_WAY_KIND)]
    async with conn.transaction():
        await conn.execute("TRUNCATE way_directions")
        await conn.execute(
            "CREATE TEMP TABLE _oneway_regulations (regulation_id text PRIMARY KEY, excepts_bicycles boolean NOT NULL)"
            " ON COMMIT DROP")
        await conn.copy_records_to_table("_oneway_regulations", records=regulations,
                                         columns=["regulation_id", "excepts_bicycles"])
        await place_regulations(conn, "_oneway_regulations", line_half_width_m)
        await conn.execute(_WAY_REGULATIONS, edge_share, max_angle_deg)
        await conn.execute(_WAY_FACTS)
        await conn.execute("CREATE INDEX ON _way_facts USING GIST (geom)")
        await conn.execute("ANALYZE _way_facts")
        started = time.perf_counter()
        count = affected_rows(await conn.execute(_insert_sql(named_gap_m, geometric_gap_m, bearing_tolerance_deg)))
        divided = await conn.fetchval("SELECT count(*) FROM way_directions WHERE divided")
        regulated = await conn.fetchval("SELECT count(*) FROM _way_regulations")
        logger.info("通行方向を決めた: %d本（上下線の片側 %d本・一方通行の規制 %d件が当たった道 %d本） / %.1f秒",
                    count, divided, len(regulations), regulated, time.perf_counter() - started)
