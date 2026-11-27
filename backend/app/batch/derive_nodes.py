"""ノードの種別（`node_kinds`）と、信号の交差点（`signal_places`）とそこに入る点（`signal_place_nodes`）を作る。

**種別（`kind`）は取込ではなく、ここで付ける。**取込は外部が持っていたタグをそのまま
入れるだけで、「これはPOIか」「どの種別か」という判断は派生の側の仕事である。判断が
変わったら、生データを取り直さずにこの段を作り直せばよい（後ろの段は入口が足す）。

**信号の交差点は、信号の点を`cluster_distance_m`でまとめた場所の1通りに決める。**点（頂点も、種別の付いた点も）は、
場所の信号の点から`signal_radius_m`以内ならその場所に入り、2つの場所に入る点は一番近い信号の点の場所に入る。曲がる所の
信号の待ち（道路網の配列の頂点）・道の側の信号の数（数の段）・地図の信号の点は、どれもこの場所を読む——別々に決めると、
同じ交差点で待ちが抜けるか片方だけ付く。

**処理はDB内で完結する。**タグを読むためだけに行を取り出さない。タグから種別への
引き当ての表と式は`domain/traffic.py`が持ち、このバッチはそれを差し込んだSQL文を組むだけである。
"""

import logging
import time

import asyncpg

from app.batch.common import affected_rows
from app.domain.geo import degrees_covering_m
from app.domain.traffic import (
    SIGNAL_KIND,
    TAG_KIND_RULES,
    TRAFFIC_SIGNAL_SQL,
    VENDING_PRIORITY,
    first_rule_sql,
    rule_match_sql,
    stop_cluster_sql,
    vending_kind_sql,
)
from app.domain.tuning import STOP_CLUSTER_DISTANCE_ID, require_tuning
from app.infrastructure.source_models import NODES_SOURCE_SQL

logger = logging.getLogger("ridecompass.derive_nodes")


def _source_nodes(extra_columns: str = "") -> str:
    """タグから種別・信号を判定する側が期待する形（`id`・`tags`）へ生データを写す。
    タグの無いノード（形状の頂点）はどの規則にも当たらないので、先に落とす。"""
    return (f"SELECT n.osm_node_id AS id, n.tags{extra_columns}"
            f" FROM {NODES_SOURCE_SQL} n WHERE n.tags <> '{{}}'::jsonb")


def tag_kind_sql(source: str) -> str:
    """`source`（`id`・`tags`を返す関係）の各行へ、停止要因・補給休憩の種別を1つ付ける。どれにも当たらない行は返らない。"""
    return f"""
WITH src AS ({source}),
matched AS ({rule_match_sql("src", TAG_KIND_RULES)}
    UNION ALL
    SELECT v.id, v.result, {VENDING_PRIORITY}
    FROM (SELECT s.id, {vending_kind_sql("s.tags")} AS result FROM src s) v
    WHERE v.result IS NOT NULL)
SELECT b.id, b.result AS kind FROM ({first_rule_sql("matched")}) b
"""


_INSERT_KINDS = f"""
INSERT INTO node_kinds (osm_node_id, kind)
SELECT k.id, k.kind FROM ({tag_kind_sql(_source_nodes())}) k
"""

#: 信号の点と、その場所の番号（`$1`はまとめる距離）。信号の判定（`TRAFFIC_SIGNAL_SQL`）に当たる点に、種別が信号の点を足す——
#: 種別の規則は値を揃えてから比べるので、判定に当たらない書き方の信号もある。足すと、種別が信号の点は必ずどこかの場所に入る。
_SIGNAL_NODES = f"""
CREATE TEMP TABLE _signal_nodes ON COMMIT DROP AS
SELECT s.id AS osm_node_id, s.geom, {stop_cluster_sql("s.geom", "$1", "true")} AS place_id
FROM ({_source_nodes(", geom")}) s LEFT JOIN node_kinds k ON k.osm_node_id = s.id
WHERE {TRAFFIC_SIGNAL_SQL} OR k.kind = '{SIGNAL_KIND}'
"""

_INSERT_PLACES = """
INSERT INTO signal_places (place_id, geom)
SELECT place_id, ST_Centroid(ST_Collect(geom)) FROM _signal_nodes GROUP BY place_id
"""

#: 信号の点の側から近くの点を探す——索引を引く回数が、全ノード数ではなく信号の数で決まる。半径で探すのは、交差点そのもの
#: ではなく流入路ごとに信号の点が置かれ、`osm_node_id`の一致では大半を取りこぼすため。`&&`の前置フィルタを先に置くのは、
#: `::geography`へのキャストがgeometryのGiSTを使えなくするため。矩形で絞ってから正確な距離を測る。
_INSERT_PLACE_NODES = f"""
INSERT INTO signal_place_nodes (osm_node_id, place_id)
SELECT DISTINCT ON (near.osm_node_id) near.osm_node_id, s.place_id
FROM _signal_nodes s
JOIN {NODES_SOURCE_SQL} near
  ON near.geom && ST_Expand(s.geom, $2)
 AND ST_DWithin(s.geom::geography, near.geom::geography, $1)
ORDER BY near.osm_node_id, ST_Distance(s.geom::geography, near.geom::geography), s.place_id
"""


async def derive(conn: asyncpg.Connection, *, signal_radius_m: float, cluster_distance_m: float) -> None:
    """`signal_radius_m`は較正値`signal.match_radius_m`（信号の点から何m以内の点をその交差点のものとみなすか）、
    `cluster_distance_m`は較正値`stop.cluster_distance_m`（信号の点をまとめる距離）。"""
    require_tuning({STOP_CLUSTER_DISTANCE_ID: cluster_distance_m}, cluster_distance_m >= 0, "0以上")
    started = time.perf_counter()

    async with conn.transaction():
        await conn.execute("TRUNCATE node_kinds, signal_place_nodes, signal_places")
        classified = affected_rows(await conn.execute(_INSERT_KINDS))
        await conn.execute("ANALYZE node_kinds")
        await conn.execute(_SIGNAL_NODES, cluster_distance_m)
        signals = await conn.fetchval("SELECT count(*) FROM _signal_nodes")
        await conn.execute("ANALYZE _signal_nodes")
        places = affected_rows(await conn.execute(_INSERT_PLACES))
        in_places = affected_rows(await conn.execute(
            _INSERT_PLACE_NODES, signal_radius_m, degrees_covering_m(signal_radius_m)))

    logger.info("ノードの値を埋めた: 種別が付いた %d点 / 信号 %d点・交差点 %d（まとめる距離 %.1fm）・入る点 %d（半径 %.1fm） / %.1f秒",
                classified, signals, places, cluster_distance_m, in_places, signal_radius_m,
                time.perf_counter() - started)
