"""地点の標高を、取り込んだ標高タイル（`source_features`の`raster`）から DB の中で引く。

点の標高は、まわりの4画素の双線形補間で引く（`infrastructure/source_models.py: dem_bilinear_corners_sql`）。

同じ地点に複数の製品のタイルがありうる。**どの製品の値を採るかは点ごとに決める**——配信元の定める精度の順
（`domain/gsi_tiles.py: PRODUCT_PRIORITY`）に見て、4画素のどれかに値のある最初の製品を採る。4画素のうち値の無い画素
（その製品の範囲の外・欠測）は外し、値のある画素だけで重みを付け直す——外さずに下の製品で埋めると、精度の違う製品の値が
1点の中で混ざる。どの製品にも値が無い点は欠測のまま残る。

**製品を優先順に1つずつ流す**ので、上の製品に値のある点は下の製品を読まない——下の製品は、欠けた点のあるタイルだけを読む。
製品ごとにズームが違っても、その製品のズームで番地を出せば同じ式で済む。
"""

import asyncpg

from app.domain.gsi_tiles import PRODUCT_PRIORITY
from app.domain.region import tile_position_sql
from app.infrastructure.source_models import (
    DEM_TILES_SQL,
    INGESTED_DEM_PRODUCTS_SQL,
    dem_bilinear_corners_sql,
    dem_pixel_value_sql,
    dem_tile_pixels_sql,
)

_POINT_TILE_X, _POINT_TILE_Y = tile_position_sql("v.lon", "v.lat", "$1")


async def products_in_priority(conn: asyncpg.Connection) -> list[tuple[str, int]]:
    """取り込まれた製品とそのズームを、値を採る順に並べる。順を知らない製品は読まない。"""
    zooms = {r["product"]: r["zoom"] for r in await conn.fetch(INGESTED_DEM_PRODUCTS_SQL)}
    return [(p, zooms[p]) for p in PRODUCT_PRIORITY if p in zooms]


async def fill_elevations(conn: asyncpg.Connection, points: str, elevations: str,
                          products: list[tuple[str, int]]) -> dict[str, int]:
    """表`points`（列`vid`・`lon`・`lat`）の点の標高を、製品`products`（`products_in_priority`の並び）の順に引いて、
    一時の表`elevations`（列`vid`が主キー・`elev`）を空けて入れる。値のある点だけが行を持つ。製品ごとに入れた行の数を返す。

    点のまわりの画素はタイルの番地の表へ一度実体にし、索引を張ってから引く——関数から直に結合すると行数を見積もれず、プランナが
    タイル側を入れ子で読み直す計画を選ぶ。タイルは1枚ずつ1回だけ展開し、そのタイルの画素を番地の索引で引く
    （`infrastructure/source_models.py: dem_tile_pixels_sql`）。表は取引の終わりに消える一時の表として作るので、取引の中で呼ぶ。

    **表は、同じ取引の中では消さずに`TRUNCATE`で空けて使い回す**——取引の中で消した表のファイルは取引の終わりまでディスクに
    残るので、同じ取引で何度も呼ぶと、呼んだ分の表がディスクに積もる。同じ取引で作った表の`TRUNCATE`は、ファイルをその場で縮める。"""
    await conn.execute(f"CREATE TEMP TABLE IF NOT EXISTS {elevations} (vid bigint PRIMARY KEY, elev double precision) ON COMMIT DROP")
    await conn.execute(f"TRUNCATE {elevations}")
    await conn.execute("CREATE TEMP TABLE IF NOT EXISTS _dem_point_pixel "
                       "(vid bigint, tx int, ty int, ix int, iy int, w double precision) ON COMMIT DROP")
    await conn.execute("CREATE INDEX IF NOT EXISTS _dem_point_pixel_tile ON _dem_point_pixel (tx, ty)")
    filled = {}
    for product, zoom in products:
        await conn.execute("TRUNCATE _dem_point_pixel")
        await conn.execute(f"""
INSERT INTO _dem_point_pixel (vid, tx, ty, ix, iy, w)
SELECT v.vid, bc.tx, bc.ty, bc.ix, bc.iy, bc.w
FROM {points} v
CROSS JOIN LATERAL (SELECT {_POINT_TILE_X} AS fx, {_POINT_TILE_Y} AS fy) p
{dem_bilinear_corners_sql("p.fx", "p.fy", "$2")}
WHERE bc.w > 0 AND NOT EXISTS (SELECT 1 FROM {elevations} e WHERE e.vid = v.vid)
""", zoom, product)
        await conn.execute("ANALYZE _dem_point_pixel")
        filled[product] = await conn.fetchval(f"""
WITH added AS (
INSERT INTO {elevations} (vid, elev)
SELECT a.vid, sum(a.w * a.elev) / sum(a.w)
FROM (SELECT DISTINCT tx, ty FROM _dem_point_pixel) k
JOIN {DEM_TILES_SQL} t
  ON t.attrs->>'product' = $1 AND (t.attrs->>'x')::int = k.tx AND (t.attrs->>'y')::int = k.ty
{dem_tile_pixels_sql("t", "g")}
CROSS JOIN LATERAL (
  SELECT v.vid, v.w, {dem_pixel_value_sql("g", "v.ix", "v.iy")} AS elev
  FROM _dem_point_pixel v WHERE v.tx = k.tx AND v.ty = k.ty OFFSET 0) a
WHERE a.elev IS NOT NULL
GROUP BY a.vid
RETURNING 1)
SELECT count(*) FROM added
""", product)
        await conn.execute(f"ANALYZE {elevations}")
    return filled
