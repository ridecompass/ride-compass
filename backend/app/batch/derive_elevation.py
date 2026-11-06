"""標高のタイルを区間に沿った断面の点で引いて、区間の標高と勾配（`edge_elevation`）にする。

**断面の点は、区間を等しい道のりに刻んだ点**で、刻みは較正値（引数`profile_step_m`）以下にする。形状点で引くと、
点の間隔が描き手ごとにばらつき、細かく描いた道ほど標高データの揺らぎを登りとして積む。刻みが勾配をならす幅になる
——刻みより短い区間は両端の2点だけで、刻みより細かい起伏は数えない。

**橋かトンネルの区間は刻まずに両端だけを引く**。配信元のDEMは地表面の値で構造物の高さを反映しないため
（https://maps.gsi.go.jp/development/hyokochi.html に明記）、中間の点は桁や坑道ではなく下の地形を指す——谷を渡る平らな橋で、
谷底の起伏がそのまま獲得標高へ積まれてしまう。橋台・坑口は道が地面と接する位置なので、両端の標高は使える。

**橋の端の点は、その点の周り（較正値`bridge_end_radius_m`の半径の8方位）とその点のうち、一番高い値を採る**。OSM の橋の端が、
DEM が構造物を除いた範囲（水門の下の水面・高架の下の谷底）に入ると、端の点そのものは橋台の載る堤防や岸より低い値を返す。
橋の両端だけを引く作りではその値がそのまま橋の高さになり、端を共有する隣の道にも急な偽の坂ができる。構造物を除いた所は
周りより低いので、周りの一番高い値が橋台の高さに近い。同じ頂点を端に持つ区間（橋と、続く道）は同じ値を採る。トンネルの坑口には
当てない——坑口の周りは山肌で、一番高い値は道より高い。

標高の生データは`source_features`にタイル1枚=1行、`raster`として入っている。**面のまま
持つ派生は作らない**——面を読む出口は「そのまま見せる」か「線へ落とす」のどちらかで、
面のままの中間結果を要る相手がいない。

**処理はDB内で完結する。**画素をプロセスへ取り出さず、1点の画素を引く（`ST_Value`）。

同じ地点に複数の製品のタイルがありうる。**どの製品の値を採るかは画素ごとに決める**
——配信元の定める精度の順（`dem_tile_store.PRODUCT_PRIORITY`）に見て、値のある最初の製品を
採る。どの製品にも値が無い画素は欠測のまま残る。

**区間の値は、その区間の形と、区間が橋かトンネルかと、端が橋の端か（隣の区間が橋か）と、標高のタイルと刻みと半径だけで決まる**。
作り直しの入口が前回の表のスキーマを渡したとき（タイルとコードと較正値が前回と同じ）は、座標の並びまで同じ形で橋かトンネルかも
同じ区間へ前回の値を写し、残りの区間だけ画素を引く。橋かトンネルの端に接する区間は、今回か前回のどちらかで接していれば写さずに
計算する——隣の区間が橋になった・橋でなくなったことを、区間の形と自分の橋かトンネルかでは見分けられないため。前回の表は読むだけで、
書くのは作業用のスキーマの表だけ。

値の出し方そのものはdomainが持つ（`elevation_values_sql`）。このバッチは画素の引き方を
組み立てるだけで、勾配の上限を持たない。
"""

import logging
import time

import asyncpg

from app.batch.common import affected_rows, copy_reused_sql, reused_edges_sql
from app.batch.dem_tile_store import PRODUCT_PRIORITY
from app.domain.attributes import elevation_values_sql
from app.domain.region import tile_position_sql
from app.domain.material_sql import IS_BRIDGE_SQL, IS_TUNNEL_SQL
from app.infrastructure.source_models import DEM_TILES_SQL, WAYS_SOURCE_SQL

logger = logging.getLogger("ridecompass.derive_elevation")

_SHAPES = f"""CREATE TEMP TABLE _shape ON COMMIT DROP AS
SELECT e.osm_way_id, e.segment_index, e.geom, e.distance_m, e.from_node_id, e.to_node_id,
       ({IS_TUNNEL_SQL} OR {IS_BRIDGE_SQL}) AS on_structure, {IS_BRIDGE_SQL} AS on_bridge
FROM road_edges e JOIN {WAYS_SOURCE_SQL} w ON w.osm_way_id = e.osm_way_id
"""
#: 今回の橋かトンネルの区間の端の頂点。ここに接する区間は前回の値を写さない。
_STRUCTURE_ENDS = """CREATE TEMP TABLE _structure_end ON COMMIT DROP AS
SELECT from_node_id AS node_id FROM _shape WHERE on_structure
UNION SELECT to_node_id FROM _shape WHERE on_structure
"""
#: 橋の区間の端の頂点とその位置。標高を周りの一番高い値にする頂点。
_BRIDGE_ENDS = """CREATE TEMP TABLE _bridge_end ON COMMIT DROP AS
SELECT DISTINCT ON (node_id) node_id, geom FROM (
  SELECT from_node_id AS node_id, ST_StartPoint(geom) AS geom FROM _shape WHERE on_bridge
  UNION ALL SELECT to_node_id, ST_EndPoint(geom) FROM _shape WHERE on_bridge) b
ORDER BY node_id
"""

#: 断面の点を一度実体にしてからタイルへ結合する。関数から直に結合すると行数を見積もれず、
#: プランナがタイル側を入れ子で読み直す計画を選ぶ。前回の値を写した区間（`_reused`）は作らない。
#:
#: 刻みの数は「区間の長さ÷`$1`（刻みの上限）」の切り上げで、点は地表の道のりで等しく置く（`geography`の内挿）。
#: 経緯度のまま内挿すると、東西と南北で1度の長さが違うぶん、曲がった区間で点の間隔がずれる。両端は内挿せずに形の端を使い、
#: 内挿の副問い合わせは`OFFSET 0`で外へ展開させない（展開されると経度と緯度の取り出しごとに内挿が走る）。
_VERTICES = """
CREATE TEMP TABLE _vertex ON COMMIT DROP AS
SELECT row_number() OVER () AS vid, s.osm_way_id, s.segment_index, i AS ord, s.distance_m * i / k.steps AS along_m,
       ST_X(p.geom) AS lon, ST_Y(p.geom) AS lat, s.on_structure,
       CASE WHEN i = 0 THEN s.from_node_id WHEN i = k.steps THEN s.to_node_id END AS node_id
FROM _shape s
CROSS JOIN LATERAL (SELECT CASE WHEN s.on_structure THEN 1
                                ELSE greatest(1, ceil(s.distance_m / $1::float8))::int END AS steps) k
CROSS JOIN LATERAL generate_series(0, k.steps) AS i
CROSS JOIN LATERAL (
    SELECT CASE WHEN i = 0 THEN ST_StartPoint(s.geom)
                WHEN i = k.steps THEN ST_EndPoint(s.geom)
                ELSE ST_LineInterpolatePoint(s.geom::geography, i::float8 / k.steps)::geometry END AS geom
    OFFSET 0) p
WHERE NOT EXISTS (SELECT 1 FROM _reused r
                  WHERE r.osm_way_id = s.osm_way_id AND r.segment_index = s.segment_index)
"""

#: 橋の端の周りの8方位の点を、区間を持たない頂点（`osm_way_id`が空）として足す。`$1`は半径（m）。画素は区間の頂点と
#: 同じ引き方で引き、`_RAISE_BRIDGE_ENDS`が端の頂点へ一番高い値を写す。計算する区間の頂点がある端だけを足す。
_BRIDGE_END_PROBES = """
INSERT INTO _vertex (vid, lon, lat, node_id)
SELECT (SELECT max(vid) FROM _vertex) + row_number() OVER (), ST_X(p.geom), ST_Y(p.geom), b.node_id
FROM _bridge_end b
CROSS JOIN LATERAL generate_series(0, 7) AS k
CROSS JOIN LATERAL (SELECT ST_Project(b.geom::geography, $1::float8, radians(45 * k))::geometry AS geom) p
WHERE EXISTS (SELECT 1 FROM _vertex v WHERE v.node_id = b.node_id)
"""
#: 頂点ごとに採った標高。値のある画素だけを入れるので、行の無い頂点はまだどの製品でも
#: 値が見つかっていない。
_VERTEX_ELEVATION_TABLE = """
CREATE TEMP TABLE _vertex_elev (vid bigint PRIMARY KEY, elev double precision) ON COMMIT DROP
"""

#: 頂点のタイル座標（小数）の式。`$2`は製品のズーム。
_VERTEX_TILE_X, _VERTEX_TILE_Y = tile_position_sql("v.lon", "v.lat", "$2")

#: 1製品ぶん、まだ値の無い頂点に画素を引く。**製品を優先順に1つずつ流す**ので、上の製品に
#: 値のある頂点は下の製品を読まない——読む画素は欠けた頂点の分だけ増える。
#:
#: **どのタイルのどの画素かは算術で出す。**`ST_Intersects(rast, 点)`で絞ると当たり判定の
#: たびにタイルの画素が実体化され、外枠だけで絞ると境界線上の点が隣のタイルへ割り当たる。
#: 番地で決めれば、rasterに触らずに1枚・1画素へ確定する。製品ごとにズームが違っても、
#: その製品のズームで番地を出せば同じ式で済む。
#:
#: 標高は`scale`で割って戻す（取込が整数へ詰めているため。尺度だけはrasterが持てない）。
#: 幅は`attrs`が持つ——rasterから読むと、そのたびに画素が実体化される。
_FILL_FROM_PRODUCT = f"""
INSERT INTO _vertex_elev (vid, elev)
SELECT vid, elev FROM (
  SELECT a.vid,
         ST_Value(t.rast, 1,
                  least(w.n, floor((a.fx - a.tx) * w.n)::int + 1),
                  least(w.n, floor((a.fy - a.ty) * w.n)::int + 1))
         / (t.attrs->>'scale')::float AS elev
  FROM (SELECT v.vid, p.fx, p.fy, floor(p.fx)::int AS tx, floor(p.fy)::int AS ty
        FROM _vertex v
        CROSS JOIN LATERAL (SELECT {_VERTEX_TILE_X} AS fx, {_VERTEX_TILE_Y} AS fy) p
        WHERE NOT EXISTS (SELECT 1 FROM _vertex_elev e WHERE e.vid = v.vid)) a
  JOIN {DEM_TILES_SQL} t
    ON t.attrs->>'product' = $1
   AND (t.attrs->>'x')::int = a.tx AND (t.attrs->>'y')::int = a.ty
  CROSS JOIN LATERAL (SELECT (t.attrs->>'width')::int AS n) w
) s
WHERE elev IS NOT NULL
"""

#: 橋の端の頂点（端を共有する区間のすべて）へ、その頂点と周りの点のうち一番高い値を写す。
_RAISE_BRIDGE_ENDS = """
INSERT INTO _vertex_elev (vid, elev)
SELECT v.vid, m.elev
FROM _vertex v
JOIN (SELECT p.node_id, max(e.elev) AS elev
      FROM _vertex p JOIN _vertex_elev e ON e.vid = p.vid
      WHERE p.node_id IN (SELECT node_id FROM _bridge_end)
      GROUP BY p.node_id) m ON m.node_id = v.node_id
WHERE v.osm_way_id IS NOT NULL
ON CONFLICT (vid) DO UPDATE SET elev = EXCLUDED.elev
"""
_VERTEX_ELEVATIONS = """
SELECT v.osm_way_id, v.segment_index, v.ord, v.along_m, v.on_structure, e.elev
FROM _vertex v LEFT JOIN _vertex_elev e ON e.vid = v.vid
WHERE v.osm_way_id IS NOT NULL
"""

_ELEVATION_COLUMNS = ("start_elevation_m", "end_elevation_m", "elevation_gain_m", "elevation_loss_m",
                      "average_grade", "steepest_gain_percent", "steepest_loss_percent", "on_structure",
                      "elevation_profile_m")

#: 値の出た区間だけを入れる。`$1`は断面の刻みの上限（m）。
_INSERT_ELEVATION = f"""
INSERT INTO edge_elevation (osm_way_id, segment_index, {", ".join(_ELEVATION_COLUMNS)})
SELECT osm_way_id, segment_index, {", ".join(_ELEVATION_COLUMNS)}
FROM ({elevation_values_sql(_VERTEX_ELEVATIONS, "$1::float8")}) v
"""


def _reused_edges_sql(previous: str | None) -> str:
    """前回の値を写す区間。形に加えて、橋かトンネルかも前回と同じ区間だけを写す。前回に行の無かった区間は、
    橋かトンネルかが変わっても今回も行を持たない——行が出るかは値のある頂点の数だけで決まる。橋かトンネルの端に接する区間は、
    今回（`_structure_end`）か前回（前回の表の橋かトンネルの区間の端）のどちらかで接していれば写さない。"""
    if previous is None:
        return reused_edges_sql(None, "_shape")
    return reused_edges_sql(previous, "_shape", f"""LEFT JOIN {previous}.edge_elevation v
  ON v.osm_way_id = s.osm_way_id AND v.segment_index = s.segment_index
WHERE (v.osm_way_id IS NULL OR v.on_structure = s.on_structure)
  AND NOT EXISTS (SELECT 1 FROM _structure_end n WHERE n.node_id IN (s.from_node_id, s.to_node_id))
  AND NOT EXISTS (SELECT 1 FROM {previous}.road_edges pe JOIN {previous}.edge_elevation pv
                    ON pv.osm_way_id = pe.osm_way_id AND pv.segment_index = pe.segment_index AND pv.on_structure
                  WHERE p.from_node_id IN (pe.from_node_id, pe.to_node_id)
                     OR p.to_node_id IN (pe.from_node_id, pe.to_node_id))""")


async def _products_in_priority(conn: asyncpg.Connection) -> list[tuple[str, int]]:
    """取り込まれた製品とそのズームを、画素の値を採る順に並べる。

    順を知らない製品や、1製品に2つのズームがあれば止める——どちらも、どの値を採るかを
    決められない。
    """
    rows = await conn.fetch(
        "SELECT attrs->>'product' AS product, array_agg(DISTINCT (attrs->>'z')::int) AS zooms"
        f" FROM {DEM_TILES_SQL} t GROUP BY 1")
    zooms = {r["product"]: r["zooms"] for r in rows}
    unknown = sorted(set(zooms) - set(PRODUCT_PRIORITY))
    mixed = sorted(p for p, z in zooms.items() if len(z) != 1)
    if unknown or mixed:
        raise ValueError(f"標高タイルの製品を並べられません: 順を知らない {unknown}"
                         f" / ズームが複数 {mixed}")
    return [(p, zooms[p][0]) for p in PRODUCT_PRIORITY if p in zooms]


async def _derive_elevation(conn: asyncpg.Connection, previous: str | None, profile_step_m: float,
                            bridge_end_radius_m: float) -> None:
    started = time.perf_counter()
    products = await _products_in_priority(conn)
    await conn.execute("TRUNCATE edge_elevation")
    if not products:
        logger.warning("標高タイルが1枚も取り込まれていません")
        return

    edges = await conn.fetchval("SELECT count(*) FROM road_edges")
    await conn.execute(_SHAPES)
    await conn.execute("ANALYZE _shape")
    await conn.execute(_STRUCTURE_ENDS)
    await conn.execute(_BRIDGE_ENDS)
    await conn.execute("ANALYZE _structure_end, _bridge_end")
    await conn.execute(_reused_edges_sql(previous))
    await conn.execute("ANALYZE _reused")
    reused = await conn.fetchval("SELECT count(*) FROM _reused")
    if previous is not None:
        await conn.execute(copy_reused_sql("edge_elevation", _ELEVATION_COLUMNS, previous))
    logger.info("標高: 形と橋・トンネルの変わらない区間 %d本へ前回の値を写し、%d本を計算する", reused, edges - reused)
    await conn.execute(_VERTICES, profile_step_m)
    probes = affected_rows(await conn.execute(_BRIDGE_END_PROBES, bridge_end_radius_m))
    logger.info("標高: 橋の端 %d点を、周り%.0fmの8方位の点のうち一番高い値にする", probes // 8, bridge_end_radius_m)
    await conn.execute("ANALYZE _vertex")
    await conn.execute(_VERTEX_ELEVATION_TABLE)
    vertices = await conn.fetchval("SELECT count(*) FROM _vertex")
    remaining = vertices
    for product, zoom in products:
        filled = affected_rows(await conn.execute(_FILL_FROM_PRODUCT, product, zoom))
        remaining -= filled
        logger.info("標高: %s（z%d）で頂点 %d点に値が付いた / 残り %d/%d点",
                    product, zoom, filled, remaining, vertices)
        await conn.execute("ANALYZE _vertex_elev")
    await conn.execute(_RAISE_BRIDGE_ENDS)
    updated = affected_rows(await conn.execute(_INSERT_ELEVATION, profile_step_m))

    logger.info("標高: 計算した区間 %d/%d本に値が付いた / %.1f秒",
                updated, edges - reused, time.perf_counter() - started)


async def derive(conn: asyncpg.Connection, *, previous: str | None, profile_step_m: float,
                 bridge_end_radius_m: float) -> None:
    """`previous`は前回の表のスキーマ。Noneなら全区間を計算する。`profile_step_m`は断面の刻みの上限（m）、
    `bridge_end_radius_m`は橋の端の標高を探す半径（m）。"""
    async with conn.transaction():
        await _derive_elevation(conn, previous, profile_step_m, bridge_end_radius_m)
