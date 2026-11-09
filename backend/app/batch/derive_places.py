"""地点（`places`）を、地点の生データ（Overture の地点・国の文化財の建造物）から作り直す。

**群はここで付ける**。取込は外部が持っていた列をそのまま入れるだけで、「どの群か」は派生の側の判断である。
語の表は`domain/stop_place.py`が持ち、このバッチはそれをSQLへ渡すだけで、行を取り出さない。群に入らない地点
（駅・公園の外の分類の店・役所等）も、群を持たない地点として入れる——地点の検索に出す。

群は分類とチェーンから決め直す（`domain/stop_place.py: place_group_sql`）。同じ群・同じチェーン
（`domain/stop_place.py: chain_sql`）で`MERGE_RADIUS_M`以内に並ぶ地点は、確からしさの最も高い1つにまとめる（同じなら識別子の
小さいほう。組の決め方は`_INSERT`）。まとまりは近い点を連ねて作るので、端と端がその距離より離れることがある。チェーンの
分からない地点は別々の店としてまとめない。群を持たずチェーンの分かる地点は、同じチェーンの群を持つ地点が近くにあれば落とす
（`_MERGE_INTO_GROUPED`）。店の中の ATM の地点は、名前を店の名前へ直してから群とチェーンを決める（`store_name_sql`）——
店の隣にあれば店とまとまり、無ければ店として残る。

チェーンの分からない地点のうち名前に日本語の文字が無いもの（`japanese_name_sql`）は、群（`CONTACT_MERGE_RADIUS_M`の群だけ）が
同じで同じ連絡先（`contacts_sql`）を持つ、チェーンの分からない日本語の名前の地点があれば落とし、その地点へ寄せる（寄せ先の
名前・位置・確からしさはそのまま）。使う連絡先は、それを持つ地点が全部互いにその群の距離以内にあるものだけ——遠くの地点とも
共有する連絡先は、会社・一覧のページや、百貨店・管理事務所の代表の電話で、その場所のものでない。日本語の名前どうし・
日本語でない名前どうしは寄せない（同じ連絡先を持つ同じ施設群の中の別の場所を残す）。

寺社は文化財の建造物の所有者から出す。所有者の欄の1人ずつのうち寺社の名前（`temple_shrine_owner_sql`）を持つ建物を、
同じ名前（表記の揺れを除いた形）で`HERITAGE_MERGE_RADIUS_M`以内に連なるものごとに1つの寺社にする。位置はまとまりの
重心に最も近い建物（重心は境内の外に落ちることがある）、名前は所有者の名前。1つの建物に寺社の所有者が2人いれば、
両方の寺社に入る。

辺り（`area`）は、入れた地点の位置を含む小地域の境界の名前（`infrastructure/place_area_query.py: area_label_sql`）で、
入れるときに求める（あとから全行を書き換えると、死んだ行が全行ぶん残ったまま表が入れ替わる）。
ほかの段の表も道の網も読まない。
"""

import logging
import time

import asyncpg

from app.batch.common import affected_rows
from app.domain.geo import degrees_covering_m, ground_m_sql
from app.domain.stop_place import (
    CONTACT_MERGE_RADIUS_M,
    HERITAGE_MERGE_RADIUS_M,
    MERGE_RADIUS_M,
    StopPlaceGroup,
    address_parts_sql,
    address_sql,
    chain_sql,
    chain_text_sql,
    contacts_sql,
    japanese_name_sql,
    normalized_sql,
    overture_group_sql,
    owner_lines_sql,
    owner_name_sql,
    place_group_sql,
    store_name_sql,
    temple_shrine_owner_sql,
)
from app.infrastructure.place_area_query import area_label_sql
from app.infrastructure.source_models import BUNKA_HERITAGES_SOURCE_SQL, OVERTURE_PLACES_SOURCE_SQL, Source

logger = logging.getLogger("ridecompass.derive_places")

_PLACES = f"""
CREATE TEMP TABLE _places ON COMMIT DROP AS
SELECT c.overture_id, c.name, c.normalized_name, c.confidence, c.geom, c.categories,
       {address_sql("c.region", "c.locality", "c.freeform")} AS address, c.chain,
       {place_group_sql("c.class_group", "c.chain")} AS place_group
FROM (
    SELECT g.*, {chain_sql(chain_text_sql("g.normalized_name"), chain_text_sql("g.normalized_brand"))} AS chain
    FROM (
        SELECT n.*, {normalized_sql("n.name")} AS normalized_name, {normalized_sql("n.brand")} AS normalized_brand
        FROM (
            SELECT o.overture_id, {store_name_sql("o.name")} AS name, o.brand, o.confidence, o.geom,
                   {overture_group_sql("o.hierarchy")} AS class_group,
                   CASE WHEN jsonb_typeof(o.hierarchy) = 'array'
                        THEN ARRAY(SELECT jsonb_array_elements_text(o.hierarchy))::varchar[] END AS categories,
                   {address_parts_sql("o.addresses")}
            FROM {OVERTURE_PLACES_SOURCE_SQL} o
        ) n
    ) g
) c
"""

#: 地点の連絡先（1つの連絡先が1行）と、寄せに使える連絡先（2つ以上の地点が持ち、それを持つ地点（群を問わない）の広がりが
#: どれかの群の距離以内のもの）の広がり。広がりは経度・緯度の外接の矩形の対角の地面の m——最も離れた2点の間より短くならない
#: ので、広がりが群の距離以内なら持つ地点どうしは互いにその距離以内にある（2点ずつ測ると、コンビニのチェーンのサイトのように
#: 数千の地点が持つ連絡先で数千万回測り、地点ごとに地面の m の平面へ写すと関東の約50万行で1分半かかる）。一時の表は
#: 統計を持たないので、寄せで結ぶ表を`ANALYZE`する（無いと結合を入れ子の繰り返しで組み、関東の地点で10分を超える）。
_CONTACTS = f"""
CREATE TEMP TABLE _contacts ON COMMIT DROP AS
SELECT o.overture_id, c.contact, ST_X(o.geom) AS lon, ST_Y(o.geom) AS lat
FROM {OVERTURE_PLACES_SOURCE_SQL} o CROSS JOIN LATERAL ({contacts_sql("o.websites", "o.phones")}) c;
CREATE TEMP TABLE _contact_spans ON COMMIT DROP AS
SELECT contact, span FROM (
    SELECT contact, count(*) AS holders,
           ST_Distance(ST_MakePoint(min(lon), min(lat))::geography, ST_MakePoint(max(lon), max(lat))::geography) AS span
    FROM _contacts GROUP BY contact
) c
WHERE holders > 1 AND span <= {max(CONTACT_MERGE_RADIUS_M.values())};
ANALYZE _contacts;
ANALYZE _contact_spans;
ANALYZE _places
"""

_CONTACT_RADII = ", ".join(f"('{group}', {radius})" for group, radius in CONTACT_MERGE_RADIUS_M.items())

# 日本語の名前の地点は落とさないので、寄せ先が連なって消えることはない。群を持たない地点は距離の表に無く、寄せない。
_MERGE_BY_CONTACT = f"""
DELETE FROM _places f
USING (
    SELECT DISTINCT fc.overture_id
    FROM _contact_spans s
    JOIN _contacts fc ON fc.contact = s.contact
    JOIN _contacts jc ON jc.contact = s.contact
    JOIN _places fp ON fp.overture_id = fc.overture_id
    JOIN _places j ON j.overture_id = jc.overture_id
    JOIN (VALUES {_CONTACT_RADII}) AS r(place_group, radius) ON r.place_group = fp.place_group
    WHERE s.span <= r.radius AND fp.chain IS NULL AND NOT {japanese_name_sql("fp.name")}
      AND j.place_group = fp.place_group AND j.chain IS NULL AND {japanese_name_sql("j.name")}
) merged
WHERE f.overture_id = merged.overture_id
"""

# 群を持つ地点は落とさないので、寄せ先が連なって消えることはない。範囲の箱で索引を引いてから地面の距離で比べる。
_MERGE_INTO_GROUPED = f"""
CREATE INDEX ON _places USING gist (geom) WHERE place_group IS NOT NULL;
DELETE FROM _places f
USING _places j
WHERE f.place_group IS NULL AND f.chain IS NOT NULL AND j.place_group IS NOT NULL AND j.chain = f.chain
  AND j.geom && ST_Expand(f.geom, {degrees_covering_m(MERGE_RADIUS_M)})
  AND ST_DWithin(f.geom::geography, j.geom::geography, {MERGE_RADIUS_M})
"""

# 辺りは、まとめたあとに残る行だけで引く（DISTINCT ON の選ぶ列で引くと、まとめて捨てる行にも境界を引く）。
_INSERT = f"""
INSERT INTO places (source, source_key, name, search_name, place_group, chain, categories, address, confidence, area, geom)
SELECT '{Source.OVERTURE_PLACE}', kept.overture_id, kept.name, kept.normalized_name, kept.place_group, kept.chain,
       kept.categories, kept.address, kept.confidence, {area_label_sql("kept.geom")}, kept.geom
FROM (
    SELECT DISTINCT ON (place_group, chain, kind, merge_key) *
    FROM (
        -- まとまりの番号は組ごとに0から振られるので、鍵は組と一緒に使う。群を持たない地点の組は、同じチェーンでも細かい
        -- 分類が違えば分ける（同じブランドの映画館と銀行を1つにしない）。
        SELECT k.*, 'c' || ST_ClusterDBSCAN({ground_m_sql("k.geom")}, eps := $1, minpoints := 1)
                           OVER (PARTITION BY k.place_group, k.chain, k.kind) AS merge_key
        FROM (
            SELECT o.*, CASE WHEN o.place_group IS NULL THEN o.categories[array_upper(o.categories, 1)] END AS kind
            FROM _places o WHERE o.chain IS NOT NULL
        ) k
        UNION ALL
        SELECT o.*, NULL, 'p' || o.overture_id FROM _places o WHERE o.chain IS NULL
    ) keyed
    ORDER BY place_group, chain, kind, merge_key, confidence DESC, overture_id
) kept
"""

#: 寺社の所有者ごとの建物（1つの建物に寺社の所有者が2人いれば2行）。
_TEMPLE_BUILDINGS = f"""
CREATE TEMP TABLE _temple_buildings ON COMMIT DROP AS
SELECT h.heritage_id, h.geom, o.name, {normalized_sql("o.name")} AS normalized_name
FROM {BUNKA_HERITAGES_SOURCE_SQL} h
CROSS JOIN LATERAL (
    SELECT DISTINCT {owner_name_sql("line")} AS name FROM {owner_lines_sql("h.owners")} AS line
) o
WHERE {temple_shrine_owner_sql("o.name")}
"""

# 鍵は名前とまとまりの中の最も小さい文化財の ID の組（1つの建物が2つの寺社に入ると、ID だけでは重なる）。
_INSERT_TEMPLES = f"""
INSERT INTO places (source, source_key, name, search_name, place_group, confidence, area, geom)
SELECT '{Source.BUNKA_HERITAGE}', kept.first_id || ' ' || kept.normalized_name, kept.name, kept.normalized_name,
       '{StopPlaceGroup.TEMPLE_SHRINE}', 1, {area_label_sql("kept.geom")}, kept.geom
FROM (
SELECT DISTINCT ON (normalized_name, merge_key) *
FROM (
    SELECT c.*, min(c.heritage_id) OVER temple AS first_id, ST_Centroid(ST_Collect(c.geom) OVER temple) AS center
    FROM (
        SELECT b.*, ST_ClusterDBSCAN({ground_m_sql("b.geom")}, eps := $1, minpoints := 1)
                    OVER (PARTITION BY b.normalized_name) AS merge_key
        FROM _temple_buildings b
    ) c
    WINDOW temple AS (PARTITION BY c.normalized_name, c.merge_key)
) centered
ORDER BY normalized_name, merge_key, ST_Distance({ground_m_sql("geom")}, {ground_m_sql("center")}), heritage_id
) kept
"""


async def derive(conn: asyncpg.Connection) -> None:
    """地点の表を入れ直す。"""
    started = time.perf_counter()
    async with conn.transaction():
        await conn.execute("DELETE FROM places")
        await conn.execute(_PLACES)
        read = await conn.fetchval("SELECT count(*) FROM _places")
        await conn.execute(_CONTACTS)
        merged_by_contact = affected_rows(await conn.execute(_MERGE_BY_CONTACT))
        merged_into_grouped = affected_rows(await conn.execute(_MERGE_INTO_GROUPED))
        inserted = affected_rows(await conn.execute(_INSERT, MERGE_RADIUS_M))
        await conn.execute(_TEMPLE_BUILDINGS)
        temple_buildings = await conn.fetchval("SELECT count(*) FROM _temple_buildings")
        temples = affected_rows(await conn.execute(_INSERT_TEMPLES, HERITAGE_MERGE_RADIUS_M))
        grouped = await conn.fetchval("SELECT count(*) FROM places WHERE place_group IS NOT NULL")
        located = await conn.fetchval("SELECT count(*) FROM places WHERE area IS NOT NULL")
    logger.info("地点: Overture の地点 %d件 → 連絡先で寄せて %d件減・群を持つ同じ店へ寄せて %d件減 → まとめて %d件、"
                "寺社の文化財 %d件 → 寺社 %d件、うち群を持つ %d件・辺りの付いた %d件 / %.1f秒", read, merged_by_contact,
                merged_into_grouped, inserted, temple_buildings, temples, grouped, located, time.perf_counter() - started)
