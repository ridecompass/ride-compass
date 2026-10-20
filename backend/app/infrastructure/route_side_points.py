"""区間ごとに、近くの点（停止要因・補給・立ち寄り先・事故）を区間の形の上の位置つきで引く読み出し。

近さの規則は点の種類ごとに違う: 停止要因は道の上にあるもの（`batch/derive_counts.py`が数えるのと同じく区間と交わる点）、
補給と立ち寄り先は道から`ROUTE_SIDE_POINT_MAX_DISTANCE_M`以内、事故は`ACCIDENT_MATCH_MAX_DISTANCE_M`以内で
最も近い区間だけ（集計が事故を付ける区間と同じ）。点の種別・まとめる行・コンビニの出どころは地図の点のタイル
（`infrastructure/point_tile_layers.py`）と同じ式で読むので、グラフの印と地図の点が同じ呼び名になる。
"""

from sqlalchemy import Float, Text, bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY

from app.domain.accident import ACCIDENT_MATCH_MAX_DISTANCE_M, BICYCLE_SQL, FATAL_SQL
from app.domain.geo import degrees_covering_m
from app.domain.primary_attributes import ATTR_ACCIDENT_POINT, ATTR_STOP_POI, PRIMARY_ATTRIBUTES_BY_ID, stop_poi_map_group_sql
from app.domain.route_points import ROUTE_SIDE_POINT_MAX_DISTANCE_M
from app.domain.stop_place import StopPlaceGroup
from app.domain.traffic import STOP_POI_KINDS, stop_kind_sql
from app.infrastructure.source_models import ACCIDENTS_SOURCE_SQL, NODES_SOURCE_SQL

_SUPPLY_POI = PRIMARY_ATTRIBUTES_BY_ID["supply_poi"].attr_id
_STOP_PLACE = PRIMARY_ATTRIBUTES_BY_ID["stop_place"].attr_id

#: 点に添える値の列。列の名前は点の一次属性の表示軸・名前・事実の`property`（地図の点の地物と同じ鍵）で、
#: 点の種類に無い列はNULLにする。
SIDE_POINT_PROPERTIES = ("kind", "group", "name", "involves_bicycle", "fatal", "occurred_year")

_NULLS = {column: f"NULL::{kind}" for column, kind in (
    ("kind", "text"), ("group", "text"), ("name", "text"),
    ("involves_bicycle", "boolean"), ("fatal", "boolean"), ("occurred_year", "int"),
)}


def _hit(layer: str, point_key: str, merge_group: str, geom: str, **values: str) -> str:
    """1つの種類の当たりの列。区間は`w`、点の位置は`geom`の式。"""
    columns = ", ".join(f'{values.get(column, _NULLS[column])} AS "{column}"' for column in SIDE_POINT_PROPERTIES)
    return (f"w.osm_way_id, w.segment_index, '{layer}' AS layer, {point_key} AS point_key, {merge_group} AS merge_group,"
            f" {columns}, ST_LineLocatePoint(w.geom, {geom}) AS fraction,"
            f" ST_Distance(w.geom::geography, {geom}::geography) AS distance_m")


def _near(geom: str, deg: str, m: str) -> str:
    return f"{geom} && ST_Expand(w.geom, {deg}) AND ST_DWithin(w.geom::geography, {geom}::geography, {m})"


ROUTE_SIDE_POINTS_SQL = text(f"""
WITH w AS (
    SELECT re.osm_way_id, re.segment_index, re.geom
    FROM unnest(CAST(:way_ids AS bigint[]), CAST(:segment_indexes AS int[])) AS ids(osm_way_id, segment_index)
    JOIN road_edges re ON re.osm_way_id = ids.osm_way_id AND re.segment_index = ids.segment_index
)
SELECT {_hit(ATTR_STOP_POI.attr_id, "'n' || p.osm_node_id", stop_poi_map_group_sql("nm"), "p.geom",
             kind=stop_kind_sql("nm"))}
FROM w
JOIN {NODES_SOURCE_SQL} p ON p.geom && w.geom AND ST_Intersects(w.geom, p.geom)
JOIN node_kinds nm ON nm.osm_node_id = p.osm_node_id
WHERE nm.kind = ANY(:stop_kinds)
UNION ALL
SELECT {_hit(_SUPPLY_POI, "'n' || p.osm_node_id", "NULL", "p.geom", kind=stop_kind_sql("nm"))}
FROM w
JOIN {NODES_SOURCE_SQL} p ON {_near("p.geom", ":near_deg", ":near_m")}
JOIN node_kinds nm ON nm.osm_node_id = p.osm_node_id
WHERE NOT nm.kind = ANY(:stop_kinds)
UNION ALL
-- コンビニは立ち寄り先の群「コンビニ」の行から補給の点として出す。群の値が種別の値。
SELECT {_hit(_SUPPLY_POI, "'s' || s.source || ':' || s.source_key", "NULL", "s.geom", kind="s.place_group", name="s.name")}
FROM w
JOIN stop_places s ON {_near("s.geom", ":near_deg", ":near_m")}
WHERE s.place_group = :convenience_group
UNION ALL
SELECT {_hit(_STOP_PLACE, "'s' || s.source || ':' || s.source_key", "NULL", "s.geom",
             group="s.place_group", name="s.name")}
FROM w
JOIN stop_places s ON {_near("s.geom", ":near_deg", ":near_m")}
WHERE s.place_group <> :convenience_group
UNION ALL
-- 事故は近くの区間ごとに最も近い区間を探し、それが当の区間である行だけを残す（事故1件は1区間にだけ載る）。
SELECT {_hit(ATTR_ACCIDENT_POINT.attr_id, "'a' || md5(ST_AsBinary(a.geom))", "NULL", "a.geom",
             involves_bicycle=BICYCLE_SQL, fatal=FATAL_SQL, occurred_year="a.occurred_year")}
FROM w
JOIN {ACCIDENTS_SOURCE_SQL} a ON {_near("a.geom", ":accident_deg", ":accident_m")}
CROSS JOIN LATERAL (
    SELECT e.osm_way_id, e.segment_index FROM road_edges e
    WHERE e.geom && ST_Expand(a.geom, :accident_deg)
      AND ST_DWithin(e.geom::geography, a.geom::geography, :accident_m)
    ORDER BY ST_Distance(e.geom::geography, a.geom::geography), e.osm_way_id, e.segment_index
    LIMIT 1) n
WHERE n.osm_way_id = w.osm_way_id AND n.segment_index = w.segment_index
""").bindparams(
    bindparam("stop_kinds", value=sorted(STOP_POI_KINDS), type_=ARRAY(Text())),
    bindparam("near_m", value=ROUTE_SIDE_POINT_MAX_DISTANCE_M, type_=Float()),
    bindparam("near_deg", value=degrees_covering_m(ROUTE_SIDE_POINT_MAX_DISTANCE_M), type_=Float()),
    bindparam("accident_m", value=ACCIDENT_MATCH_MAX_DISTANCE_M, type_=Float()),
    bindparam("accident_deg", value=degrees_covering_m(ACCIDENT_MATCH_MAX_DISTANCE_M), type_=Float()),
    bindparam("convenience_group", value=StopPlaceGroup.CONVENIENCE.value, type_=Text()),
)
