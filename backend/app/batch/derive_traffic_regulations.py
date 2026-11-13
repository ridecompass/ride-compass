"""交通規制を区間へ当てて、区間に効く規制の時間帯（`edge_traffic_regulations`）にする。

規制ごとに、いつ・誰に効くかを決めるのはdomain（`domain/traffic_regulation.py`）で、このバッチは決めた値を規制の場所に
重ねて区間へ落とす。規制の場所は、線の規制なら線の周りの帯、面の規制なら面そのもの。区間の長さのうち一定の割合以上が
場所の中にある区間へ当て、1つの区間に2つ以上の規制が当たれば、列ごとに強い方を取る。規制が当たった区間だけが行を持つ。
"""

import logging
import time

import asyncpg

from app.batch.common import affected_rows
from app.domain.traffic_regulation import REGULATION_HOURS, applies_to_bicycles, regulation_hours
from app.infrastructure.source_models import JARTIC_REGULATIONS_SOURCE_SQL, PEDESTRIAN_ROAD_KIND, regulation_slots

logger = logging.getLogger("ridecompass.derive_traffic_regulations")

_READ_REGULATIONS = f"SELECT regulation_id, slots::text AS slots FROM {JARTIC_REGULATIONS_SOURCE_SQL} r WHERE kind = $1"

#: 規制ごとの時間帯。強さは`REGULATION_HOURS`の並びの位置（1始まり）で持ち、小さいほど強い。
_HOURS_TABLE = """
CREATE TEMP TABLE _regulation_hours (regulation_id text PRIMARY KEY, hours smallint NOT NULL, bicycle_hours smallint)
ON COMMIT DROP
"""

#: 規制の場所を先に作って索引を張る。区間の長さと比べるので、帯は地上の m で膨らませる。
_BUILD_PLACES = f"""
CREATE TEMP TABLE _regulation_places ON COMMIT DROP AS
SELECT h.hours, h.bicycle_hours,
       CASE WHEN r.is_area THEN r.geom ELSE ST_Buffer(r.geom::geography, $1)::geometry END AS place
FROM _regulation_hours h JOIN {JARTIC_REGULATIONS_SOURCE_SQL} r USING (regulation_id)
"""

#: 場所の中にある区間の長さを、地上の m で区間の長さと比べる。
_INSERT_EDGES = """
INSERT INTO edge_traffic_regulations (osm_way_id, segment_index, pedestrian_road, pedestrian_road_bicycle)
SELECT e.osm_way_id, e.segment_index, ($2::text[])[min(p.hours)], ($2::text[])[min(p.bicycle_hours)]
FROM _regulation_places p JOIN road_edges e ON e.geom && p.place
WHERE ST_Length(ST_Intersection(e.geom, p.place)::geography) >= $1 * e.distance_m
GROUP BY e.osm_way_id, e.segment_index
"""


def _classify(slots_json: str) -> tuple[int, int | None]:
    """規制1件の、時間帯と自転車も対象のときの時間帯の強さ（`_HOURS_TABLE`の値）。"""
    slots = regulation_slots(slots_json)
    rank = REGULATION_HOURS.index(regulation_hours(slots)) + 1
    return rank, rank if applies_to_bicycles(slots) else None


async def derive(conn: asyncpg.Connection, *, line_half_width_m: float, edge_share: float) -> None:
    """線の規制は線から`line_half_width_m`までの帯を場所とし、長さの`edge_share`以上が場所の中にある区間へ当てる。"""
    started = time.perf_counter()
    regulations = await conn.fetch(_READ_REGULATIONS, PEDESTRIAN_ROAD_KIND)
    records = [(row["regulation_id"], *_classify(row["slots"])) for row in regulations]
    async with conn.transaction():
        await conn.execute("TRUNCATE edge_traffic_regulations")
        if not records:
            logger.warning("交通規制（歩行者用道路）が1件も取り込まれていません")
            return
        await conn.execute(_HOURS_TABLE)
        await conn.copy_records_to_table("_regulation_hours", records=records)
        await conn.execute(_BUILD_PLACES, line_half_width_m)
        await conn.execute("CREATE INDEX ON _regulation_places USING GIST (place)")
        await conn.execute("ANALYZE _regulation_places")
        edges = affected_rows(await conn.execute(_INSERT_EDGES, edge_share, list(REGULATION_HOURS)))
    logger.info("交通規制: 歩行者用道路 %d件（自転車も対象 %d件）を区間 %d本に当てた / %.1f秒",
                len(records), sum(bicycle is not None for _, _, bicycle in records), edges, time.perf_counter() - started)
