"""標高のタイルを区間に沿った断面の点で引いて、区間の標高と勾配（`edge_elevation`）にする。

**標高を拾う点は、区間を等しい道のりに分けた点**で、間隔は較正値（引数`profile_step_m`）以下にする。形状点で引くと、
点の間隔が描き手ごとにばらつき、細かく描いた道ほど標高データの揺らぎを登りとして積む。拾った点は、揺れの閾値（引数
`profile_tolerance_m`）で間引いてから表に残す（`domain/attributes.py: elevation_values_sql`）。

**橋かトンネルの区間は刻まずに両端だけを引く**。配信元のDEMは地表面の値で構造物の高さを反映しないため
（https://maps.gsi.go.jp/development/hyokochi.html に明記）、中間の点は桁や坑道ではなく下の地形を指す——谷を渡る平らな橋で、
谷底の起伏がそのまま獲得標高へ積まれてしまう。橋台・坑口は道が地面と接する位置なので、両端の標高は使える。

**橋・トンネルの端の頂点は、道に沿って近い地面の標高で直す**（GraphHopper の
https://github.com/graphhopper/graphhopper/blob/master/core/src/main/java/com/graphhopper/reader/dem/BridgeTunnelTowerCorrection.java
と同じ手順）。OSM の橋の端が DEM の構造物を除いた範囲（水門の下の水面・高架の下の谷底）に入ると、端の点は橋台より低い値を
返し、トンネルの坑口は山肌の高い値を返す。端の頂点から構造物でない区間だけを道のりで`STRUCTURE_GROUND_SEARCH_M`までたどり、
着いた地面の頂点と、その長さで打ち切った所の DEM の値を、道のりの2乗に反比例する重み（道のりは最低1m）で平均した値に
置き換える（頂点に DEM の値が無ければ、その値で埋める）。置き換えで、頂点に接する区間の勾配の最大が前より急になるなら取り消す
（構造物の区間は`STRUCTURE_SLOPE_FLOOR`まで許す。取り消しが出なくなるまで繰り返す）。勾配は区間の両端の間で測るが、下の引き直しに
合わせ、`STRUCTURE_GROUND_SEARCH_M`より長い地面の区間はその長さの位置との間で測る。置き換えた頂点に接する地面の区間は、その頂点から
`STRUCTURE_GROUND_SEARCH_M`以内の点を直線に引き直す——GraphHopper は区間の形状点を全部引き直すが、ここは5m おきに点を持つので、
区間全部を引き直すと遠くの起伏まで消える。

**構造物の内側の頂点（構造物の区間にしか接しない頂点）は、構造物の外へつながる頂点から補う**（GraphHopper の
https://github.com/graphhopper/graphhopper/blob/master/core/src/main/java/com/graphhopper/reader/dem/EdgeElevationInterpolator.java
と`NodeElevationInterpolator.java`・`ElevationInterpolator.java`と同じ式。トンネル、橋の順）。途中の頂点で区間が分かれた橋の
内側の頂点は、真下の谷底や川面を返す。同じ種類（橋かトンネル）の区間でつながった頂点の組ごとに、外へつながる頂点が1つなら
その値、2つなら経緯度の平面の距離で直線、3つなら3点を通る平面（ほぼ一直線なら一番離れた2点の直線）、4つ以上なら経緯度の距離の
2乗に反比例する重みの平均を採る。

標高の生データは`source_features`にタイル1枚=1行、`raster`として入っている。**面のまま
持つ派生は作らない**——面を読む出口は「そのまま見せる」か「線へ落とす」のどちらかで、
面のままの中間結果を要る相手がいない。

**画素はDB内で引く。**画素をプロセスへ取り出さず、頂点のあるタイルをDBの中で1枚ずつ展開して引く。

同じ地点に複数の製品のタイルがありうる。どの製品の値を採るかは点ごとに決める
（`infrastructure/dem_elevation.py: fill_elevations`）。頂点ごとに採った標高は表`_vertex_elev`に入り、行の無い頂点は値が無い。


値の出し方そのものはdomainが持つ（`elevation_values_sql`）。このバッチは画素の引き方を
組み立てるだけで、勾配の上限を持たない。
"""

import logging
import math
import time

import asyncpg

from app.batch.common import affected_rows
from app.domain.attributes import elevation_values_sql
from app.domain.material_sql import IS_BRIDGE_SQL, IS_TUNNEL_SQL
from app.domain.tuning import (
    ELEVATION_PROFILE_STEP_ID,
    ELEVATION_PROFILE_TOLERANCE_ID,
    require_tuning,
)
from app.infrastructure.dem_elevation import fill_elevations, products_in_priority
from app.infrastructure.source_models import WAYS_SOURCE_SQL

logger = logging.getLogger("ridecompass.derive_elevation")

#: 1つの塊に入れる点の数の目安（点の表・番地の表・値の表がメモリに収まる大きさ）。全部の点を一度に一時の表へ載せると、
#: 本番（約5,500万点）では3つの表が約14GBになってVM のメモリ（12GB）に収まらず、ディスクを読み書きして点の数の比より
#: 2〜5倍遅くなった。本番の範囲で340万点までは、点の数に比例する速さで流れることを確かめた。
CHUNK_POINTS = 3_000_000

#: 橋・トンネルの端の頂点から、地面の標高を集めにたどる道のりの長さ（m）。置き換えた頂点に接する地面の区間を引き直す長さも同じ。
#: GraphHopper の`BridgeTunnelTowerCorrection`の`MAX_DIST_M`と同じ値。
STRUCTURE_GROUND_SEARCH_M = 50.0
#: 端の頂点の置き換えで、構造物の区間の勾配が増えても許す上限（割合）。両端が同じ誤った DEM を返す平らな橋を両端そろって
#: 直すと、小さな本当の勾配が出るため。GraphHopper の`STRUCTURE_SLOPE_FLOOR`と同じ値。
STRUCTURE_SLOPE_FLOOR = 0.015

#: 区間の形と、構造物の種類（トンネル・橋・どちらでもなければ NULL）、断面の刻みの数・塊の番号。`$1`は刻みの上限（m）、
#: `$2`は塊の点の数の目安。
#:
#: 刻みの数は「区間の長さ÷`$1`」の切り上げで、橋かトンネルの区間は1（両端だけ）。塊は、区間を始まりの点の geohash の順に
#: 並べ、点の数（刻み＋1）を積んで`$2`ごとに切る——geohash の順は近い区間を続けて並べるので、塊が狭い範囲にまとまり、
#: 塊の境をまたぐ標高のタイルが少ない。
_SHAPES = f"""CREATE TEMP TABLE _shape ON COMMIT DROP AS
SELECT s.*, ((sum(s.steps + 1) OVER (ORDER BY ST_GeoHash(ST_StartPoint(s.geom)), s.osm_way_id, s.segment_index) - 1)
             / $2::bigint)::int AS chunk
FROM (SELECT b.*, b.structure IS NOT NULL AS on_structure,
             CASE WHEN b.structure IS NOT NULL THEN 1 ELSE greatest(1, ceil(b.distance_m / $1::float8))::int END AS steps
      FROM (SELECT e.osm_way_id, e.segment_index, e.geom, e.distance_m, e.from_node_id, e.to_node_id,
                   CASE WHEN {IS_TUNNEL_SQL} THEN 'tunnel' WHEN {IS_BRIDGE_SQL} THEN 'bridge' END AS structure
            FROM road_edges e JOIN {WAYS_SOURCE_SQL} w ON w.osm_way_id = e.osm_way_id) b) s
"""
#: 区間の両端の頂点と位置・接する区間（頂点ごとに接する区間の数だけ行がある）。
_ENDPOINTS = """CREATE TEMP TABLE _endpoint ON COMMIT DROP AS
SELECT from_node_id AS node_id, ST_StartPoint(geom) AS geom, to_node_id AS adj, osm_way_id, segment_index, distance_m,
       on_structure, structure FROM _shape
UNION ALL SELECT to_node_id, ST_EndPoint(geom), from_node_id, osm_way_id, segment_index, distance_m, on_structure, structure
FROM _shape
"""
#: 構造物（橋かトンネル）の区間に接する頂点と、地面の区間にも接するか。端を共有する区間が別の塊に入っても同じ値を採るよう、
#: 塊に分ける前の全部の区間から作る。
_STRUCTURE_NODES = """CREATE TEMP TABLE _structure_node ON COMMIT DROP AS
SELECT node_id, bool_or(NOT on_structure) AS ground FROM _endpoint GROUP BY node_id HAVING bool_or(on_structure)
"""
#: 地面の区間を両向きにたどる表（頂点 → 隣の頂点・区間の長さ・その頂点が区間の始まりか）。
_GROUND_STEPS = """CREATE TEMP TABLE _ground_step ON COMMIT DROP AS
SELECT from_node_id AS node_id, to_node_id AS adj, distance_m AS len, osm_way_id, segment_index, true AS from_start
FROM _shape WHERE NOT on_structure
UNION ALL SELECT to_node_id, from_node_id, distance_m, osm_way_id, segment_index, false FROM _shape WHERE NOT on_structure
"""
#: 地面にも接する構造物の頂点ごとに、地面の区間だけをたどって着いた頂点と最短の道のり。最短の道のりが縮まなくなるまで、
#: 前の回に縮んだ頂点からだけ広げる（`$1`はたどる長さ）。
#: 道のりでたどる探索は PostGIS に無く、pgRouting は入れていないので、ここで最短の道のりを広げる。
_WALK_TABLE = """
CREATE TEMP TABLE _walk (start bigint, node bigint, dist float8, fresh boolean, PRIMARY KEY (start, node)) ON COMMIT DROP
"""
_WALK_SEED = "INSERT INTO _walk SELECT node_id, node_id, 0, true FROM _structure_node WHERE ground"
_WALK_FRONTIER = """CREATE TEMP TABLE _frontier ON COMMIT DROP AS SELECT start, node, dist FROM _walk WHERE fresh"""
_WALK_STEP = """
INSERT INTO _walk (start, node, dist, fresh)
SELECT f.start, s.adj, min(f.dist + s.len), true
FROM _frontier f JOIN _ground_step s ON s.node_id = f.node
WHERE f.dist + s.len <= $1
GROUP BY f.start, s.adj
ON CONFLICT (start, node) DO UPDATE SET dist = EXCLUDED.dist, fresh = true WHERE EXCLUDED.dist < _walk.dist
"""
#: 標高を引く点: 着いた地面の頂点（構造物に接しない頂点だけ。道のりつき）・たどる長さを越える区間の打ち切りの点（道のりは
#: たどる長さ）・構造物の頂点とその隣の頂点（置き換える前の値と、ガードで勾配を比べる値）。打ち切りの点のうち、構造物の頂点そのもの
#: から出る区間の上のもの（`cut_way`）は、ガードがその区間の勾配を測る位置にもなる。`$1`はたどる長さ。
_STRUCTURE_PROBES = """
CREATE TEMP TABLE _vertex ON COMMIT DROP AS
SELECT row_number() OVER () AS vid, ST_X(geom) AS lon, ST_Y(geom) AS lat, start, dist, node_id, cut_way, cut_segment FROM (
    SELECT w.start, w.dist, p.geom, NULL::bigint AS node_id, NULL::bigint AS cut_way, NULL::int AS cut_segment
    FROM _walk w JOIN LATERAL (SELECT geom FROM _endpoint e WHERE e.node_id = w.node LIMIT 1) p ON true
    WHERE w.node <> w.start AND NOT EXISTS (SELECT 1 FROM _structure_node n WHERE n.node_id = w.node)
    UNION ALL
    SELECT w.start, $1::float8, ST_LineInterpolatePoint(sh.geom::geography,
               CASE WHEN s.from_start THEN ($1 - w.dist) / s.len ELSE 1 - ($1 - w.dist) / s.len END)::geometry, NULL,
           CASE WHEN w.node = w.start THEN s.osm_way_id END, CASE WHEN w.node = w.start THEN s.segment_index END
    FROM _walk w JOIN _ground_step s ON s.node_id = w.node
    JOIN _shape sh ON sh.osm_way_id = s.osm_way_id AND sh.segment_index = s.segment_index
    WHERE w.dist < $1 AND w.dist + s.len > $1
    UNION ALL
    SELECT NULL, NULL, p.geom, p.node_id, NULL, NULL
    FROM (SELECT DISTINCT ON (e.node_id) e.node_id, e.geom FROM _endpoint e
          WHERE e.node_id IN (SELECT node_id FROM _structure_node)
             OR e.node_id IN (SELECT x.adj FROM _endpoint x JOIN _structure_node n ON n.node_id = x.node_id)
          ORDER BY e.node_id) p) q
"""
#: 構造物の頂点から出る長い地面の区間の、たどる長さの位置の DEM の値。
_CUTS = """CREATE TEMP TABLE _cut ON COMMIT DROP AS
SELECT v.start, v.cut_way AS osm_way_id, v.cut_segment AS segment_index, e.elev
FROM _vertex v JOIN _vertex_elev e ON e.vid = v.vid WHERE v.cut_way IS NOT NULL
"""
#: 頂点の DEM の値（置き換える前）。
_NODE_DEM = """CREATE TEMP TABLE _node_dem ON COMMIT DROP AS
SELECT v.node_id, e.elev FROM _vertex v JOIN _vertex_elev e ON e.vid = v.vid WHERE v.node_id IS NOT NULL
"""
#: 置き換えの案: 集めた地面の値の、道のりの2乗に反比例する重み（道のりは最低1m）の平均。前の値と違う頂点と、DEM の値の無い頂点。
_PROPOSALS = """CREATE TEMP TABLE _node_fix ON COMMIT DROP AS
SELECT m.start AS node_id, d.elev AS obs, m.elev
FROM (SELECT v.start, sum(e.elev / greatest(v.dist, 1) ^ 2) / sum(1 / greatest(v.dist, 1) ^ 2) AS elev
      FROM _vertex v JOIN _vertex_elev e ON e.vid = v.vid WHERE v.start IS NOT NULL GROUP BY v.start) m
LEFT JOIN _node_dem d ON d.node_id = m.start
WHERE d.elev IS NULL OR abs(m.elev - d.elev) > 1e-6
"""
#: ガード: 案のうち、接する区間（地面に接しない内側の頂点への区間と長さ0の区間は除く）の勾配の最大が前より急になるもの
#: （構造物の区間は前の最大と`$1`の大きい方まで許す）を取り消す。勾配は区間の両端の間で測るが、`$2`より長い地面の区間
#: （向こうの端も置き換えて`$2`の2倍以下のものを除く）は、引き直しと同じく`$2`の位置との間で測る。DEM の値の無い頂点は
#: 前の勾配が無いので取り消さない。判定は今ある案の全部を見てから消す。
_REJECT_STEEPENING = """
DELETE FROM _node_fix f USING (
    SELECT node_id FROM (
        SELECT x.node_id, x.on_structure,
               CASE WHEN c.elev IS NOT NULL AND NOT (pa.node_id IS NOT NULL AND x.distance_m <= 2 * $2::float8)
                    THEN abs(c.elev - p.obs) / $2::float8 ELSE abs(a.elev - p.obs) / x.distance_m END AS before,
               CASE WHEN c.elev IS NOT NULL AND NOT (pa.node_id IS NOT NULL AND x.distance_m <= 2 * $2::float8)
                    THEN abs(c.elev - p.elev) / $2::float8 ELSE abs(coalesce(pa.elev, a.elev) - p.elev) / x.distance_m END AS after
        FROM _endpoint x JOIN _node_fix p ON p.node_id = x.node_id
        LEFT JOIN _node_dem a ON a.node_id = x.adj
        LEFT JOIN _node_fix pa ON pa.node_id = x.adj
        LEFT JOIN _cut c ON NOT x.on_structure AND c.start = x.node_id AND c.osm_way_id = x.osm_way_id
                        AND c.segment_index = x.segment_index
        WHERE x.distance_m > 0 AND NOT EXISTS (SELECT 1 FROM _structure_node n WHERE n.node_id = x.adj AND NOT n.ground)) s
    GROUP BY node_id
    HAVING max(after) > max(before) + 1e-9
        OR coalesce(max(after) FILTER (WHERE on_structure), 0)
           > greatest(coalesce(max(before) FILTER (WHERE on_structure), 0), $1) + 1e-9) r
WHERE f.node_id = r.node_id
"""

#: 断面の点を一度実体にしてからタイルへ結合する。関数から直に結合すると行数を見積もれず、
#: プランナがタイル側を入れ子で読み直す計画を選ぶ。
#:
#: 1つの塊（`$1`）の区間の点。点は地表の道のりで等しく置く（`geography`の内挿）。
#: 経緯度のまま内挿すると、東西と南北で1度の長さが違うぶん、曲がった区間で点の間隔がずれる。両端は内挿せずに形の端を使い、
#: 内挿の副問い合わせは`OFFSET 0`で外へ展開させない（展開されると経度と緯度の取り出しごとに内挿が走る）。
_VERTICES = """
CREATE TEMP TABLE _vertex ON COMMIT DROP AS
SELECT row_number() OVER () AS vid, s.osm_way_id, s.segment_index, i AS ord, s.distance_m * i / s.steps AS along_m,
       ST_X(p.geom) AS lon, ST_Y(p.geom) AS lat, s.on_structure,
       CASE WHEN i = 0 THEN s.from_node_id WHEN i = s.steps THEN s.to_node_id END AS node_id
FROM _shape s
CROSS JOIN LATERAL generate_series(0, s.steps) AS i
CROSS JOIN LATERAL (
    SELECT CASE WHEN i = 0 THEN ST_StartPoint(s.geom)
                WHEN i = s.steps THEN ST_EndPoint(s.geom)
                ELSE ST_LineInterpolatePoint(s.geom::geography, i::float8 / s.steps)::geometry END AS geom
    OFFSET 0) p
WHERE s.chunk = $1
"""

#: 構造物の種類（`$1`）の区間でつながった頂点の組（いちばん小さい頂点の番号を組の名にする）。名が変わらなくなるまで隣から写す。
_STRUCTURE_STEPS = """CREATE TEMP TABLE _structure_step ON COMMIT DROP AS
SELECT node_id, adj FROM _endpoint WHERE structure = $1
"""
_COMPONENT_TABLE = """CREATE TEMP TABLE _component ON COMMIT DROP AS
SELECT DISTINCT node_id, node_id AS label FROM _structure_step
"""
_COMPONENT_STEP = """
UPDATE _component c SET label = m.label
FROM (SELECT x.node_id, min(a.label) AS label
      FROM _structure_step x JOIN _component a ON a.node_id = x.adj GROUP BY x.node_id) m
WHERE m.node_id = c.node_id AND m.label < c.label
"""
#: 組ごとの頂点と、外へつながるか（ほかの種類の区間にも接する）・経緯度・今の標高（置き換えた値、無ければ DEM の値）。
_COMPONENT_NODES = """
SELECT c.label, c.node_id, ST_X(p.geom) AS lon, ST_Y(p.geom) AS lat, coalesce(f.elev, d.elev) AS elev,
       EXISTS (SELECT 1 FROM _endpoint o WHERE o.node_id = c.node_id AND o.structure IS DISTINCT FROM $1) AS outer_node
FROM _component c
JOIN LATERAL (SELECT geom FROM _endpoint e WHERE e.node_id = c.node_id LIMIT 1) p ON true
LEFT JOIN _node_fix f ON f.node_id = c.node_id LEFT JOIN _node_dem d ON d.node_id = c.node_id
"""
#: 置き換えた頂点（端を共有する区間のすべて）へ、置き換えた値を写す。
_APPLY_STRUCTURE_FIXES = """
INSERT INTO _vertex_elev (vid, elev)
SELECT v.vid, f.elev FROM _vertex v JOIN _node_fix f ON f.node_id = v.node_id
ON CONFLICT (vid) DO UPDATE SET elev = EXCLUDED.elev
"""
#: 置き換えた頂点に接する地面の区間（塊`$1`の中）の点を、その頂点から`$2`以内で直線に引き直す: 置き換えた値から、`$2`の位置の
#: 値（区間が`$2`より短ければ向こうの端の値）まで。両端とも置き換え、区間が`$2`の2倍以下なら、両端の値の間の直線にする。
_RAMP_STRUCTURE_ENDS = """
WITH edges AS (
    SELECT s.osm_way_id, s.segment_index, s.distance_m AS len, ff.elev AS zf, ft.elev AS zt,
           least($2::float8, s.distance_m) AS reach
    FROM _shape s LEFT JOIN _node_fix ff ON ff.node_id = s.from_node_id LEFT JOIN _node_fix ft ON ft.node_id = s.to_node_id
    WHERE s.chunk = $1 AND NOT s.on_structure AND s.distance_m > 0 AND (ff.node_id IS NOT NULL OR ft.node_id IS NOT NULL)),
points AS (
    SELECT v.vid, v.along_m, e.elev, g.*,
           lead(v.along_m) OVER w AS next_along, lead(e.elev) OVER w AS next_elev
    FROM _vertex v JOIN edges g ON g.osm_way_id = v.osm_way_id AND g.segment_index = v.segment_index
    LEFT JOIN _vertex_elev e ON e.vid = v.vid
    WINDOW w AS (PARTITION BY v.osm_way_id, v.segment_index ORDER BY v.along_m)),
-- 引き直しの向こうの端の値: 始まりから`reach`・終わりから`reach`の位置を挟む2点の間を直線で読む。
anchors AS (
    SELECT osm_way_id, segment_index,
           max(CASE WHEN next_along IS NULL OR next_along = along_m THEN elev
                    ELSE elev + (next_elev - elev) * (reach - along_m) / (next_along - along_m) END)
               FILTER (WHERE along_m <= reach AND (next_along IS NULL OR next_along > reach)) AS at_from,
           max(CASE WHEN next_along IS NULL OR next_along = along_m THEN elev
                    ELSE elev + (next_elev - elev) * (len - reach - along_m) / (next_along - along_m) END)
               FILTER (WHERE along_m <= len - reach AND (next_along IS NULL OR next_along > len - reach)) AS at_to
    FROM points GROUP BY osm_way_id, segment_index)
INSERT INTO _vertex_elev (vid, elev)
SELECT vid, z FROM (
    SELECT p.vid, CASE
        WHEN p.zf IS NOT NULL AND p.zt IS NOT NULL AND p.len <= 2 * $2::float8 THEN p.zf + (p.zt - p.zf) * p.along_m / p.len
        WHEN p.zf IS NOT NULL AND p.along_m < p.reach THEN p.zf + (a.at_from - p.zf) * p.along_m / p.reach
        WHEN p.zt IS NOT NULL AND p.len - p.along_m < p.reach THEN p.zt + (a.at_to - p.zt) * (p.len - p.along_m) / p.reach
        END AS z
    FROM points p JOIN anchors a ON a.osm_way_id = p.osm_way_id AND a.segment_index = p.segment_index) r
WHERE z IS NOT NULL
ON CONFLICT (vid) DO UPDATE SET elev = EXCLUDED.elev
"""
_VERTEX_ELEVATIONS = """
SELECT v.osm_way_id, v.segment_index, v.ord, v.along_m, e.elev
FROM _vertex v LEFT JOIN _vertex_elev e ON e.vid = v.vid
"""

_ELEVATION_COLUMNS = ("start_elevation_m", "end_elevation_m", "elevation_gain_m", "elevation_loss_m",
                      "average_grade", "steepest_gain_percent", "steepest_loss_percent", "elevation_profile_m",
                      "elevation_profile_along_m")

#: 値の出た区間だけを入れる。`$1`は揺れを消す閾値（m）。
_INSERT_ELEVATION = f"""
INSERT INTO edge_elevation (osm_way_id, segment_index, {", ".join(_ELEVATION_COLUMNS)})
SELECT osm_way_id, segment_index, {", ".join(_ELEVATION_COLUMNS)}
FROM ({elevation_values_sql(_VERTEX_ELEVATIONS, "$1::float8")}) v
"""


async def _fill_vertices(conn: asyncpg.Connection, products: list[tuple[str, int]],
                         filled: dict[str, int]) -> tuple[int, int]:
    """今の`_vertex`の点へ、製品を優先順に流して画素の値を`_vertex_elev`に引き、点の数と値の無い点の数を返す。`filled`へ
    製品ごとの値の付いた点の数を足す。"""
    await conn.execute("ANALYZE _vertex")
    points = remaining = await conn.fetchval("SELECT count(*) FROM _vertex")
    for product, count in (await fill_elevations(conn, "_vertex", "_vertex_elev", products)).items():
        filled[product] += count
        remaining -= count
    return points, remaining


async def _drop_vertex_tables(conn: asyncpg.Connection) -> None:
    for table in ("_vertex", "_vertex_elev"):
        await conn.execute(f"DROP TABLE IF EXISTS {table}")


#: GraphHopper の`ElevationInterpolator.EPSILON`（経緯度の度）。
_INTERPOLATION_EPSILON = 0.00001


def _two_points(lat: float, lon: float, a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    """経緯度の平面の距離で、2点（緯度・経度・標高）の間を直線に読む（GraphHopper の`calculateElevationBasedOnTwoPoints`）。"""
    l0 = math.hypot(a[1] - lon, a[0] - lat)
    l1 = math.hypot(b[1] - lon, b[0] - lat)
    if l0 + l1 < _INTERPOLATION_EPSILON:
        return a[2] if l0 <= l1 else b[2]
    return round(a[2] + (b[2] - a[2]) * l0 / (l0 + l1), 2)


def _three_points(lat: float, lon: float, p0: tuple[float, float, float], p1: tuple[float, float, float],
                  p2: tuple[float, float, float]) -> float:
    """3点を通る平面で読む。ほぼ一直線なら、一番離れた2点の直線（GraphHopper の`calculateElevationBasedOnThreePoints`）。"""
    d10 = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    d20 = (p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2])
    a = d10[1] * d20[2] - d10[2] * d20[1]
    b = d10[2] * d20[0] - d10[0] * d20[2]
    c = d10[0] * d20[1] - d10[1] * d20[0]
    if abs(c) < _INTERPOLATION_EPSILON:
        d21 = (p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2])
        l10, l20, l21 = (sum(v * v for v in d) for d in (d10, d20, d21))
        if l21 > l10 and l21 > l20:
            return _two_points(lat, lon, p1, p2)
        if l20 > l10 and l20 > l21:
            return _two_points(lat, lon, p0, p2)
        return _two_points(lat, lon, p0, p1)
    return round((a * p0[0] + b * p0[1] + c * p0[2] - a * lat - b * lon) / c, 2)


def _interpolated(lat: float, lon: float, outer: list[tuple[float, float, float]]) -> float:
    """外へつながる頂点の数で式を選ぶ（GraphHopper の`NodeElevationInterpolator`と`calculateElevationBasedOnPointList`）。"""
    if len(outer) == 1:
        return outer[0][2]
    if len(outer) == 2:
        return _two_points(lat, lon, *outer)
    if len(outer) == 3:
        return _three_points(lat, lon, *outer)
    weights = []
    for p in outer:
        squared = (p[0] - lat) ** 2 + (p[1] - lon) ** 2
        if squared < _INTERPOLATION_EPSILON ** 2:
            return p[2]
        weights.append(1 / squared)
    return round(sum(w * p[2] for w, p in zip(weights, outer)) / sum(weights), 2)


async def _interpolate_inner_nodes(conn: asyncpg.Connection) -> int:
    """構造物の内側の頂点の値を、トンネル・橋の順に`_node_fix`へ足し、足した頂点の数を返す。"""
    added = 0
    for kind in ("tunnel", "bridge"):
        for table in ("_component", "_structure_step"):
            await conn.execute(f"DROP TABLE IF EXISTS {table}")
        await conn.execute(_STRUCTURE_STEPS, kind)
        await conn.execute("CREATE INDEX ON _structure_step (node_id)")
        await conn.execute(_COMPONENT_TABLE)
        await conn.execute("CREATE INDEX ON _component (node_id)")
        while affected_rows(await conn.execute(_COMPONENT_STEP)):
            pass
        groups: dict[int, tuple[list[tuple[float, float, float]], list[tuple[int, float, float]]]] = {}
        for r in await conn.fetch(_COMPONENT_NODES, kind):
            outer, inner = groups.setdefault(r["label"], ([], []))
            if r["outer_node"]:
                if r["elev"] is not None:
                    outer.append((r["lat"], r["lon"], r["elev"]))
            else:
                inner.append((r["node_id"], r["lat"], r["lon"]))
        values = [(node_id, _interpolated(lat, lon, outer)) for outer, inner in groups.values() if outer
                  for node_id, lat, lon in inner]
        await conn.execute("INSERT INTO _node_fix (node_id, elev) SELECT * FROM unnest($1::bigint[], $2::float8[])",
                           [node_id for node_id, _ in values], [elev for _, elev in values])
        added += len(values)
    return added


async def _fix_structure_ends(conn: asyncpg.Connection, products: list[tuple[str, int]]) -> tuple[int, int, int, int]:
    """橋・トンネルの頂点の置き換え（`_node_fix`）を、塊に分ける前に全部の区間で決める。構造物に接する頂点の数・
    端を置き換えた頂点の数・ガードで取り消した頂点の数・補った内側の頂点の数を返す。"""
    for sql in (_ENDPOINTS, "CREATE INDEX ON _endpoint (node_id)", "ANALYZE _endpoint",
                _STRUCTURE_NODES, "ANALYZE _structure_node",
                _GROUND_STEPS, "CREATE INDEX ON _ground_step (node_id)", "ANALYZE _ground_step",
                "CREATE INDEX ON _shape (osm_way_id, segment_index)", _WALK_TABLE, _WALK_SEED):
        await conn.execute(sql)
    while True:
        await conn.execute("DROP TABLE IF EXISTS _frontier")
        await conn.execute(_WALK_FRONTIER)
        await conn.execute("UPDATE _walk SET fresh = false WHERE fresh")
        if not affected_rows(await conn.execute(_WALK_STEP, STRUCTURE_GROUND_SEARCH_M)):
            break
    await conn.execute("ANALYZE _walk")
    await conn.execute(_STRUCTURE_PROBES, STRUCTURE_GROUND_SEARCH_M)
    await _fill_vertices(conn, products, dict.fromkeys((product for product, _ in products), 0))
    await conn.execute(_CUTS)
    await conn.execute("CREATE INDEX ON _cut (start)")
    await conn.execute(_NODE_DEM)
    await conn.execute("CREATE INDEX ON _node_dem (node_id)")
    await conn.execute(_PROPOSALS)
    await conn.execute("CREATE INDEX ON _node_fix (node_id)")
    rejected = 0
    while count := affected_rows(await conn.execute(_REJECT_STEEPENING, STRUCTURE_SLOPE_FLOOR, STRUCTURE_GROUND_SEARCH_M)):
        rejected += count
    fixed = await conn.fetchval("SELECT count(*) FROM _node_fix")
    inner = await _interpolate_inner_nodes(conn)
    await _drop_vertex_tables(conn)
    await conn.execute("ANALYZE _node_fix")
    return await conn.fetchval("SELECT count(*) FROM _structure_node"), fixed, rejected, inner


async def _derive_chunk(conn: asyncpg.Connection, chunk: int, products: list[tuple[str, int]],
                        profile_tolerance_m: float, filled: dict[str, int]) -> tuple[int, int, int]:
    """1つの塊の区間の標高を出して書き、その塊の点の数・値の無い点の数・書いた区間の数を返す。`filled`へ製品ごとの値の付いた
    点の数を足す。"""
    await _drop_vertex_tables(conn)
    await conn.execute(_VERTICES, chunk)
    points, remaining = await _fill_vertices(conn, products, filled)
    await conn.execute(_APPLY_STRUCTURE_FIXES)
    await conn.execute(_RAMP_STRUCTURE_ENDS, chunk, STRUCTURE_GROUND_SEARCH_M)
    written = affected_rows(await conn.execute(_INSERT_ELEVATION, profile_tolerance_m))
    return points, remaining, written


async def _derive_elevation(conn: asyncpg.Connection, profile_step_m: float, profile_tolerance_m: float,
                            chunk_points: int) -> None:
    started = time.perf_counter()
    products = await products_in_priority(conn)
    await conn.execute("TRUNCATE edge_elevation")
    edges = await conn.fetchval("SELECT count(*) FROM road_edges")
    await conn.execute(_SHAPES, profile_step_m, chunk_points)
    await conn.execute("CREATE INDEX ON _shape (chunk)")
    await conn.execute("ANALYZE _shape")
    structure_nodes, fixed, rejected, inner = await _fix_structure_ends(conn, products)
    logger.info("標高: 橋・トンネルに接する頂点 %d点のうち、端の %d点を道に沿って%.0fm以内の地面の標高で直し（勾配が急になる"
                " %d点は直さない）、内側の %d点を外へつながる頂点から補った / %.0f秒",
                structure_nodes, fixed, STRUCTURE_GROUND_SEARCH_M, rejected, inner, time.perf_counter() - started)
    chunks = [r["chunk"] for r in await conn.fetch("SELECT DISTINCT chunk FROM _shape ORDER BY chunk")]
    logger.info("標高: 区間 %d本を%d個の塊に分けた", edges, len(chunks))
    filled = dict.fromkeys((product for product, _ in products), 0)
    vertices = missing = updated = 0
    for done, chunk in enumerate(chunks, 1):
        points, remaining, written = await _derive_chunk(conn, chunk, products, profile_tolerance_m, filled)
        vertices, missing, updated = vertices + points, missing + remaining, updated + written
        logger.info("標高: 塊 %d/%d・点 %d（値の無い点 %d）・区間 %d本を書いた / %.0f秒",
                    done, len(chunks), points, remaining, written, time.perf_counter() - started)
    logger.info("標高: 製品ごとに値が付いた点 %s / 値の無い点 %d/%d点",
                "・".join(f"{product} {count}" for product, count in filled.items()), missing, vertices)
    logger.info("標高: 計算した区間 %d/%d本に値が付いた / %.1f秒", updated, edges, time.perf_counter() - started)


async def derive(conn: asyncpg.Connection, *, profile_step_m: float, profile_tolerance_m: float,
                 chunk_points: int = CHUNK_POINTS) -> None:
    """`profile_step_m`は標高を拾う間隔の上限（m）、`profile_tolerance_m`は揺れを消す閾値（m）、`chunk_points`は1つの塊に
    入れる点の数の目安。塊の分け方は値を変えない。"""
    require_tuning({ELEVATION_PROFILE_STEP_ID: profile_step_m}, profile_step_m > 0, "0より大きい")
    require_tuning({ELEVATION_PROFILE_TOLERANCE_ID: profile_tolerance_m}, profile_tolerance_m >= 0, "0以上")
    async with conn.transaction():
        await _derive_elevation(conn, profile_step_m, profile_tolerance_m, chunk_points)
