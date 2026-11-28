"""土地被覆の画像を区間の周りの帯で数えて、区間の土地被覆の割合（`edge_landcover`）にする。

土地被覆の生データは`source_features`にタイル1枚=1行、`raster`として入っている。**面のまま
持つ派生は作らない**——面を読む出口は「そのまま見せる」か「線へ落とす」のどちらかで、
面のままの中間結果を要る相手がいない。

**処理はDB内で完結する。**画素をプロセスへ取り出さず、帯に重なる画素を数える
（`ST_Clip` + `ST_ValueCount`）。

値の出た区間だけが行を持つ。

どの画素値を数えないか・クラスの並びはdomainが持ち、有効画素数の下限は較正値から渡す。
"""

import logging
import time

import asyncpg

from app.batch.common import affected_rows
from app.domain.landcover import PERCENT_CLASSES, landcover_key, valid_pixel_sql
from app.infrastructure.source_models import LANDCOVER_TILES_SQL

logger = logging.getLogger("ridecompass.derive_landcover")


#: 帯を先に作って索引を張る。タイル1枚ごとに作り直すと、同じ区間を何度も膨らませることになる。
#: タイルの位置はWebメルカトルなので、帯もそちらへそろえてから重ねる。
_BUILD_RINGS = """
CREATE TEMP TABLE _rings ON COMMIT DROP AS
SELECT osm_way_id, segment_index, ring AS ring4326, ST_Transform(ring, 3857) AS ring
FROM (SELECT e.osm_way_id, e.segment_index,
             ST_Difference(ST_Buffer(e.geom::geography, $1)::geometry,
                           ST_Buffer(e.geom::geography, $2)::geometry) AS ring
      FROM road_edges e) b
"""

#: 帯に重なる画素をクラスごとに数える。**数え上げはPostGIS側で行う**——画素を行へ
#: 展開すると、帯1本あたり千個の単位で行が出る。欠測の画素は`ST_Clip`が外す。
_COUNT_CLASSES = f"""
SELECT r.osm_way_id, r.segment_index, (vc).value::int AS cls, sum((vc).count)::bigint AS n
FROM _rings r
JOIN {LANDCOVER_TILES_SQL} t ON t.geom && r.ring4326
CROSS JOIN LATERAL ST_ValueCount(ST_Clip(t.rast, 1, r.ring, true)) AS vc
GROUP BY r.osm_way_id, r.segment_index, (vc).value
"""


def class_percentages_sql(counts: str, min_valid_pixels: float) -> str:
    """クラスごとの画素数から割合(%)を出すSQL。

    `counts`は`(osm_way_id, segment_index, cls, n)`を返す関係。有効画素数
    （No Data・Cloudsを除いた合計）が`min_valid_pixels`（較正値`landcover.min_valid_pixels`）未満の区間は返らない——
    帯がラスタの外へ大きくはみ出た・雲に覆われていた等、統計として信頼できないため。
    """
    tally = ",\n           ".join(
        f"sum(n) FILTER (WHERE cls = {value}) AS {landcover_key(name)}"
        for name, value in PERCENT_CLASSES)
    percents = ",\n       ".join(
        f"100.0 * coalesce({landcover_key(name)}, 0) / valid_pixels AS {name}"
        for name, _ in PERCENT_CLASSES)
    return f"""
WITH counted AS ({counts}),
agg AS (
    SELECT osm_way_id, segment_index,
           sum(n) FILTER (WHERE {valid_pixel_sql("cls")})::int AS valid_pixels,
           {tally}
    FROM counted GROUP BY osm_way_id, segment_index)
SELECT osm_way_id, segment_index, valid_pixels,
       {percents}
FROM agg WHERE valid_pixels >= {float(min_valid_pixels)!r}
"""


#: (割合の項目名, 表の列名) の対応。
_LANDCOVER_COLUMNS = [(name, "lc_" + landcover_key(name)) for name, _ in PERCENT_CLASSES]
_VALUE_COLUMNS = [column for _, column in _LANDCOVER_COLUMNS]

def _insert_sql(min_valid_pixels: float) -> str:
    return f"""
INSERT INTO edge_landcover (osm_way_id, segment_index, {", ".join(_VALUE_COLUMNS)})
SELECT osm_way_id, segment_index, {", ".join(f"p.{name}" for name, _ in _LANDCOVER_COLUMNS)}
FROM ({class_percentages_sql(_COUNT_CLASSES, min_valid_pixels)}) p
"""


async def _derive_edges(conn: asyncpg.Connection, ring_outer_m: float, ring_inner_m: float, min_valid_pixels: float) -> None:
    started = time.perf_counter()
    tiles = await conn.fetchval(f"SELECT count(*) FROM {LANDCOVER_TILES_SQL} t")
    edges = await conn.fetchval("SELECT count(*) FROM road_edges")
    await conn.execute(_BUILD_RINGS, ring_outer_m, ring_inner_m)
    await conn.execute("CREATE INDEX ON _rings USING GIST (ring4326)")
    await conn.execute("ANALYZE _rings")
    logger.info("土地被覆: 帯 %d本を作った。重なる画素を数える",
                await conn.fetchval("SELECT count(*) FROM _rings"))
    updated = affected_rows(await conn.execute(_insert_sql(min_valid_pixels)))

    logger.info("土地被覆: 数えた区間 %d/%d本に値が付いた / タイル %d枚 / %.1f秒",
                updated, edges, tiles, time.perf_counter() - started)


async def derive(conn: asyncpg.Connection, *, ring_outer_m: float, ring_inner_m: float, min_valid_pixels: float) -> None:
    """帯は道の中心線から`ring_inner_m`より外・`ring_outer_m`までで、路面そのものの幅を除く。有効な画素が`min_valid_pixels`
    より少ない区間は割合を持たない。"""
    async with conn.transaction():
        await conn.execute("TRUNCATE edge_landcover")
        await _derive_edges(conn, ring_outer_m, ring_inner_m, min_valid_pixels)
        await conn.execute("ANALYZE edge_landcover")
