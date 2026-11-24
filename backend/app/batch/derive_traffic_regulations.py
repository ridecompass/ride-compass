"""交通規制（歩行者用道路）を、規制と条件の組（`traffic_regulations`・`traffic_regulation_slots`）にし、区間へ当てる
（`edge_traffic_regulations`）。

規制がいつ・誰に効くかは畳まずに組のまま持ち、通る時刻に効くかは読む側が`domain/traffic_regulation.py: active_between`で
決める。規制の場所は、線の規制なら線の周りの帯、面の規制なら面そのもの。区間の長さのうち一定の割合以上が場所の中にある区間へ
当て、当たった規制を全部持つ。線の規制は、さらに線に沿う区間に限る。線を交差点で横切る道の短い区間は、帯にまるごと入って
割合では外せないため、区間の向きと線の向きの差で外す。
"""

import logging
import time
from dataclasses import astuple

import asyncpg

from app.batch.common import affected_rows
from app.domain.geo import bearing_sql
from app.domain.traffic_regulation import SLOT_FIELDS
from app.infrastructure.source_models import JARTIC_REGULATIONS_SOURCE_SQL, PEDESTRIAN_ROAD_KIND, regulation_slots

logger = logging.getLogger("ridecompass.derive_traffic_regulations")

_READ_REGULATIONS = f"SELECT regulation_id, slots::text AS slots FROM {JARTIC_REGULATIONS_SOURCE_SQL} r WHERE kind = $1"

#: 規制の場所を先に作って索引を張る。区間の長さと比べるので、帯は地上の m で膨らませる。線の規制は向きを比べるので線も持つ。
_BUILD_PLACES = f"""
CREATE TEMP TABLE _regulation_places ON COMMIT DROP AS
SELECT t.regulation_id,
       CASE WHEN r.is_area THEN r.geom ELSE ST_Buffer(r.geom::geography, $1)::geometry END AS place,
       CASE WHEN r.is_area THEN NULL ELSE r.geom END AS line
FROM traffic_regulations t JOIN {JARTIC_REGULATIONS_SOURCE_SQL} r USING (regulation_id)
"""

#: 区間の中点に一番近い、規制の線の1辺の向き。折れた線は、区間に沿う所の向きで比べる。同じ点が続く所の長さ0の辺は
#: 向きを持たないので選ばない。
_LINE_BEARING = f"""(
  SELECT {bearing_sql("ST_StartPoint(s.geom)", "ST_EndPoint(s.geom)")}
  FROM ST_DumpSegments(h.line) s
  WHERE ST_Length(s.geom) > 0
  ORDER BY s.geom <-> ST_LineInterpolatePoint(h.geom, 0.5) LIMIT 1)"""

#: 場所の中にある区間の長さを、地上の m で区間の長さと比べ、線の規制は区間の始点→終点の向き（`bearing_deg`）と線の向きの差を、
#: 向きを問わずに0〜90度へ畳んで比べる（`asin(|sin|)`が180度ごとに畳む。`ST_Angle`は経度・緯度を平面として測るので使わない）。向きは割合で残った組だけで比べる
#: （場所と枠が重なるだけの組は多い）。
_INSERT_EDGES = f"""
INSERT INTO edge_traffic_regulations (osm_way_id, segment_index, regulation_id)
WITH hit AS MATERIALIZED (
  SELECT e.osm_way_id, e.segment_index, e.geom, e.bearing_deg, p.regulation_id, p.line
  FROM _regulation_places p JOIN road_edges e ON e.geom && p.place
  WHERE ST_Length(ST_Intersection(e.geom, p.place)::geography) >= $1 * e.distance_m)
SELECT DISTINCT h.osm_way_id, h.segment_index, h.regulation_id
FROM hit h
WHERE h.line IS NULL OR degrees(asin(abs(sin(radians(h.bearing_deg - {_LINE_BEARING}))))) <= $2
"""


async def derive(conn: asyncpg.Connection, *, line_half_width_m: float, edge_share: float, max_angle_deg: float) -> None:
    """線の規制は線から`line_half_width_m`までの帯を場所とし、長さの`edge_share`以上が場所の中にある区間へ当てる。

    線の規制は、区間と線の向きの差が`max_angle_deg`以下の区間に限る。
    """
    started = time.perf_counter()
    regulations = await conn.fetch(_READ_REGULATIONS, PEDESTRIAN_ROAD_KIND)
    slots = [(row["regulation_id"], number, *astuple(slot))
             for row in regulations for number, slot in enumerate(regulation_slots(row["slots"]), start=1)]
    async with conn.transaction():
        await conn.execute("TRUNCATE edge_traffic_regulations, traffic_regulation_slots, traffic_regulations")
        if not regulations:
            logger.warning("交通規制（歩行者用道路）が1件も取り込まれていません")
            return
        await conn.copy_records_to_table("traffic_regulations", records=[(row["regulation_id"],) for row in regulations],
                                         columns=["regulation_id"])
        await conn.copy_records_to_table("traffic_regulation_slots", records=slots,
                                         columns=["regulation_id", "slot", *SLOT_FIELDS])
        await conn.execute(_BUILD_PLACES, line_half_width_m)
        await conn.execute("CREATE INDEX ON _regulation_places USING GIST (place)")
        await conn.execute("ANALYZE _regulation_places")
        edges = affected_rows(await conn.execute(_INSERT_EDGES, edge_share, max_angle_deg))
    bicycle_slots = sum(slot[2] for slot in slots)
    logger.info("交通規制: 歩行者用道路 %d件（条件の組 %d・うち自転車も対象 %d）を区間へ %d行当てた / %.1f秒",
                len(regulations), len(slots), bicycle_slots, edges, time.perf_counter() - started)
