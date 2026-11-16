"""標高のタイルを区間に沿った断面の点で引いて、区間の標高と勾配（`edge_elevation`）にする。

**標高を拾う点は、区間を等しい道のりに分けた点**で、間隔は較正値（引数`profile_step_m`）以下にする。形状点で引くと、
点の間隔が描き手ごとにばらつき、細かく描いた道ほど標高データの揺らぎを登りとして積む。拾った点は、揺れの閾値（引数
`profile_tolerance_m`）で間引いてから表に残す（`domain/attributes.py: elevation_values_sql`）。

**橋かトンネルの区間は刻まずに両端だけを引く**。配信元のDEMは地表面の値で構造物の高さを反映しないため
（https://maps.gsi.go.jp/development/hyokochi.html に明記）、中間の点は桁や坑道ではなく下の地形を指す——谷を渡る平らな橋で、
谷底の起伏がそのまま獲得標高へ積まれてしまう。橋台・坑口は道が地面と接する位置なので、両端の標高は使える。

**橋の端の点は、その点の周り（較正値`bridge_end_radius_m`の半径で、北から等しい角度に並べた方位）とその点のうち、一番高い値を採る**。OSM の橋の端が、
DEM が構造物を除いた範囲（水門の下の水面・高架の下の谷底）に入ると、端の点そのものは橋台の載る堤防や岸より低い値を返す。
橋の両端だけを引く作りではその値がそのまま橋の高さになり、端を共有する隣の道にも急な偽の坂ができる。構造物を除いた所は
周りより低いので、周りの一番高い値が橋台の高さに近い。同じ頂点を端に持つ区間（橋と、続く道）は同じ値を採る。トンネルの坑口には
当てない——坑口の周りは山肌で、一番高い値は道より高い。

標高の生データは`source_features`にタイル1枚=1行、`raster`として入っている。**面のまま
持つ派生は作らない**——面を読む出口は「そのまま見せる」か「線へ落とす」のどちらかで、
面のままの中間結果を要る相手がいない。

**処理はDB内で完結する。**画素をプロセスへ取り出さず、頂点のあるタイルをDBの中で1枚ずつ展開して引く。

同じ地点に複数の製品のタイルがありうる。**どの製品の値を採るかは画素ごとに決める**
——配信元の定める精度の順（`domain/gsi_tiles.py: PRODUCT_PRIORITY`）に見て、値のある最初の製品を
採る。どの製品にも値が無い画素は欠測のまま残る。


値の出し方そのものはdomainが持つ（`elevation_values_sql`）。このバッチは画素の引き方を
組み立てるだけで、勾配の上限を持たない。
"""

import logging
import time

import asyncpg

from app.batch.common import affected_rows
from app.domain.attributes import elevation_values_sql
from app.domain.gsi_tiles import PRODUCT_PRIORITY
from app.domain.region import tile_position_sql
from app.domain.material_sql import IS_BRIDGE_SQL, IS_TUNNEL_SQL
from app.domain.tuning import (
    BRIDGE_END_BEARINGS,
    ELEVATION_PROFILE_STEP_ID,
    ELEVATION_PROFILE_TOLERANCE_ID,
    require_tuning,
)
from app.infrastructure.source_models import (
    DEM_TILES_SQL,
    INGESTED_DEM_PRODUCTS_SQL,
    WAYS_SOURCE_SQL,
    dem_pixel_value_sql,
    dem_tile_pixels_sql,
)

logger = logging.getLogger("ridecompass.derive_elevation")

#: 1つの塊に入れる点の数の目安（点の表・番地の表・値の表がメモリに収まる大きさ）。全部の点を一度に一時の表へ載せると、
#: 本番（約5,500万点）では3つの表が約14GBになってVM のメモリ（12GB）に収まらず、ディスクを読み書きして点の数の比より
#: 2〜5倍遅くなった。本番の範囲で340万点までは、点の数に比例する速さで流れることを確かめた（tasks#1509）。
CHUNK_POINTS = 3_000_000

#: 区間の形と、断面の刻みの数・塊の番号。`$1`は刻みの上限（m）、`$2`は塊の点の数の目安。
#:
#: 刻みの数は「区間の長さ÷`$1`」の切り上げで、橋かトンネルの区間は1（両端だけ）。塊は、区間を始まりの点の geohash の順に
#: 並べ、点の数（刻み＋1）を積んで`$2`ごとに切る——geohash の順は近い区間を続けて並べるので、塊が狭い範囲にまとまり、
#: 塊の境をまたぐ標高のタイルが少ない。
_SHAPES = f"""CREATE TEMP TABLE _shape ON COMMIT DROP AS
SELECT s.*, ((sum(s.steps + 1) OVER (ORDER BY ST_GeoHash(ST_StartPoint(s.geom)), s.osm_way_id, s.segment_index) - 1)
             / $2::bigint)::int AS chunk
FROM (SELECT b.*, CASE WHEN b.on_structure THEN 1 ELSE greatest(1, ceil(b.distance_m / $1::float8))::int END AS steps
      FROM (SELECT e.osm_way_id, e.segment_index, e.geom, e.distance_m, e.from_node_id, e.to_node_id,
                   ({IS_TUNNEL_SQL} OR {IS_BRIDGE_SQL}) AS on_structure, {IS_BRIDGE_SQL} AS on_bridge
            FROM road_edges e JOIN {WAYS_SOURCE_SQL} w ON w.osm_way_id = e.osm_way_id) b) s
"""
#: 橋の区間の端の頂点とその位置。標高を周りの一番高い値にする頂点。端を共有する区間が別の塊に入っても同じ値を採るよう、
#: 塊に分ける前の全部の区間から作る。
_BRIDGE_ENDS = """CREATE TEMP TABLE _bridge_end ON COMMIT DROP AS
SELECT DISTINCT ON (node_id) node_id, geom FROM (
  SELECT from_node_id AS node_id, ST_StartPoint(geom) AS geom FROM _shape WHERE on_bridge
  UNION ALL SELECT to_node_id, ST_EndPoint(geom) FROM _shape WHERE on_bridge) b
ORDER BY node_id
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

#: 橋の端の周りの方位（`domain/tuning.py: BRIDGE_END_BEARINGS`）の点を、区間を持たない頂点（`osm_way_id`が空）として足す。`$1`は半径（m）。画素は区間の頂点と
#: 同じ引き方で引き、`_RAISE_BRIDGE_ENDS`が端の頂点へ一番高い値を写す。計算する区間の頂点がある端だけを足す。
_BRIDGE_END_PROBES = f"""
INSERT INTO _vertex (vid, lon, lat, node_id)
SELECT (SELECT max(vid) FROM _vertex) + row_number() OVER (), ST_X(p.geom), ST_Y(p.geom), b.node_id
FROM _bridge_end b
CROSS JOIN LATERAL generate_series(0, {BRIDGE_END_BEARINGS - 1}) AS k
CROSS JOIN LATERAL (SELECT ST_Project(b.geom::geography, $1::float8, radians({360 / BRIDGE_END_BEARINGS} * k))::geometry AS geom) p
WHERE EXISTS (SELECT 1 FROM _vertex v WHERE v.node_id = b.node_id)
"""
#: 頂点ごとに採った標高。値のある画素だけを入れるので、行の無い頂点はまだどの製品でも
#: 値が見つかっていない。
_VERTEX_ELEVATION_TABLE = """
CREATE TEMP TABLE _vertex_elev (vid bigint PRIMARY KEY, elev double precision) ON COMMIT DROP
"""

#: 頂点のタイル座標（小数）の式。`$1`は製品のズーム。
_VERTEX_TILE_X, _VERTEX_TILE_Y = tile_position_sql("v.lon", "v.lat", "$1")

#: 1製品ぶん、まだ値の無い頂点の、その製品のズームでのタイルの番地。**製品を優先順に1つずつ流す**ので、上の製品に
#: 値のある頂点は下の製品を読まない——下の製品は、欠けた頂点のあるタイルだけを読む。製品ごとにズームが違っても、
#: その製品のズームで番地を出せば同じ式で済む。
_VERTEX_TILES = f"""
CREATE TEMP TABLE _vertex_tile ON COMMIT DROP AS
SELECT v.vid, p.fx, p.fy, floor(p.fx)::int AS tx, floor(p.fy)::int AS ty
FROM _vertex v
CROSS JOIN LATERAL (SELECT {_VERTEX_TILE_X} AS fx, {_VERTEX_TILE_Y} AS fy) p
WHERE NOT EXISTS (SELECT 1 FROM _vertex_elev e WHERE e.vid = v.vid)
"""
#: 頂点のあるタイルを1枚ずつ展開し、そのタイルの頂点に画素を引く（`infrastructure/source_models.py: dem_tile_pixels_sql`）。
#: タイルの頂点は番地の索引で引く。`$1`は製品。
_FILL_FROM_PRODUCT = f"""
INSERT INTO _vertex_elev (vid, elev)
SELECT a.vid, a.elev
FROM (SELECT DISTINCT tx, ty FROM _vertex_tile) k
JOIN {DEM_TILES_SQL} t
  ON t.attrs->>'product' = $1 AND (t.attrs->>'x')::int = k.tx AND (t.attrs->>'y')::int = k.ty
{dem_tile_pixels_sql("t", "g")}
CROSS JOIN LATERAL (
  SELECT v.vid, {dem_pixel_value_sql("g", "v.fx", "v.fy", "v.tx", "v.ty")} AS elev
  FROM _vertex_tile v WHERE v.tx = k.tx AND v.ty = k.ty OFFSET 0) a
WHERE a.elev IS NOT NULL
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
SELECT v.osm_way_id, v.segment_index, v.ord, v.along_m, e.elev
FROM _vertex v LEFT JOIN _vertex_elev e ON e.vid = v.vid
WHERE v.osm_way_id IS NOT NULL
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


async def _products_in_priority(conn: asyncpg.Connection) -> list[tuple[str, int]]:
    """取り込まれた製品とそのズームを、画素の値を採る順に並べる。順を知らない製品は読まない。"""
    rows = await conn.fetch(INGESTED_DEM_PRODUCTS_SQL)
    zooms = {r["product"]: r["zoom"] for r in rows}
    return [(p, zooms[p]) for p in PRODUCT_PRIORITY if p in zooms]


async def _derive_chunk(conn: asyncpg.Connection, chunk: int, products: list[tuple[str, int]],
                        profile_tolerance_m: float, bridge_end_radius_m: float, filled: dict[str, int]) -> tuple[int, int, int]:
    """1つの塊の区間の標高を出して書き、その塊の点の数・値の無い点の数・書いた区間の数を返す。`filled`へ製品ごとの値の付いた
    点の数を足す。"""
    for table in ("_vertex", "_vertex_elev"):
        await conn.execute(f"DROP TABLE IF EXISTS {table}")
    await conn.execute(_VERTICES, chunk)
    await conn.execute(_BRIDGE_END_PROBES, bridge_end_radius_m)
    await conn.execute("ANALYZE _vertex")
    await conn.execute(_VERTEX_ELEVATION_TABLE)
    vertices = remaining = await conn.fetchval("SELECT count(*) FROM _vertex")
    for product, zoom in products:
        await conn.execute("DROP TABLE IF EXISTS _vertex_tile")
        await conn.execute(_VERTEX_TILES, zoom)
        await conn.execute("CREATE INDEX ON _vertex_tile (tx, ty)")
        await conn.execute("ANALYZE _vertex_tile")
        count = affected_rows(await conn.execute(_FILL_FROM_PRODUCT, product))
        filled[product] += count
        remaining -= count
        await conn.execute("ANALYZE _vertex_elev")
    await conn.execute(_RAISE_BRIDGE_ENDS)
    written = affected_rows(await conn.execute(_INSERT_ELEVATION, profile_tolerance_m))
    return vertices, remaining, written


async def _derive_elevation(conn: asyncpg.Connection, profile_step_m: float, profile_tolerance_m: float,
                            bridge_end_radius_m: float, chunk_points: int) -> None:
    started = time.perf_counter()
    products = await _products_in_priority(conn)
    await conn.execute("TRUNCATE edge_elevation")
    edges = await conn.fetchval("SELECT count(*) FROM road_edges")
    await conn.execute(_SHAPES, profile_step_m, chunk_points)
    await conn.execute("CREATE INDEX ON _shape (chunk)")
    await conn.execute("ANALYZE _shape")
    await conn.execute(_BRIDGE_ENDS)
    await conn.execute("ANALYZE _bridge_end")
    chunks = [r["chunk"] for r in await conn.fetch("SELECT DISTINCT chunk FROM _shape ORDER BY chunk")]
    logger.info("標高: 区間 %d本を%d個の塊に分けた。橋の端 %d点を、周り%.0fmの%d方位の点のうち一番高い値にする",
                edges, len(chunks), await conn.fetchval("SELECT count(*) FROM _bridge_end"), bridge_end_radius_m,
                BRIDGE_END_BEARINGS)
    filled = dict.fromkeys((product for product, _ in products), 0)
    vertices = missing = updated = 0
    for done, chunk in enumerate(chunks, 1):
        points, remaining, written = await _derive_chunk(conn, chunk, products, profile_tolerance_m,
                                                         bridge_end_radius_m, filled)
        vertices, missing, updated = vertices + points, missing + remaining, updated + written
        logger.info("標高: 塊 %d/%d・点 %d（値の無い点 %d）・区間 %d本を書いた / %.0f秒",
                    done, len(chunks), points, remaining, written, time.perf_counter() - started)
    logger.info("標高: 製品ごとに値が付いた点 %s / 値の無い点 %d/%d点",
                "・".join(f"{product} {count}" for product, count in filled.items()), missing, vertices)
    logger.info("標高: 計算した区間 %d/%d本に値が付いた / %.1f秒", updated, edges, time.perf_counter() - started)


async def derive(conn: asyncpg.Connection, *, profile_step_m: float, profile_tolerance_m: float,
                 bridge_end_radius_m: float, chunk_points: int = CHUNK_POINTS) -> None:
    """`profile_step_m`は標高を拾う間隔の上限（m）、`profile_tolerance_m`は揺れを消す閾値（m）、`bridge_end_radius_m`は
    橋の端の標高を探す半径（m）、`chunk_points`は1つの塊に入れる点の数の目安。塊の分け方は値を変えない。"""
    require_tuning({ELEVATION_PROFILE_STEP_ID: profile_step_m}, profile_step_m > 0, "0より大きい")
    require_tuning({ELEVATION_PROFILE_TOLERANCE_ID: profile_tolerance_m}, profile_tolerance_m >= 0, "0以上")
    async with conn.transaction():
        await _derive_elevation(conn, profile_step_m, profile_tolerance_m, bridge_end_radius_m, chunk_points)
