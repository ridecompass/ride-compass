"""地点の表（`places`）を施設の名前・群・チェーンで引く（地点の検索の施設の候補）。

入力が群の語（`domain/stop_place.py: queried_group`）ならその群の店を、チェーンの語（`queried_chain`）ならそのチェーンの店を
引き、名前に当たる店より先に並べる。名前は、派生の段が入れた表記の揺れを除いた形の列（`search_name`）を、入力を同じ式
（`domain/stop_place.py: normalized_sql`）で整えて、長い入力は部分一致・短い入力は頭の一致で引く（`CONTAINS_MIN_LENGTH`）。検索に出さない分類
（`search_excluded_sql`）の地点は引かない。候補には、派生の段が入れた辺り（`area`）を添える。時間は
docs/modules/backend/place-search.md「引き方」。
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.geo import LatLon, degrees_covering_m
from app.domain.material_sql import like_escaped_sql
from app.domain.place_search import PLACE_PREDICTION_LIMIT, PlaceCandidate
from app.domain.region import BoundingBox
from app.domain.stop_place import (
    match_rank_sql,
    normalized_form,
    normalized_sql,
    queried_chain,
    queried_group,
    search_excluded_sql,
)

#: 名前を部分一致で引く、整えた入力の最短の長さ。部分一致の索引（`pg_trgm`）が引く3文字の組の長さで、これより短い入力は
#: 名前の頭の一致で引く（照合順序`C`の範囲で、通常の索引で引ける）。
CONTAINS_MIN_LENGTH = 3

#: 地面の1mを覆う度（`domain/geo.py: degrees_covering_m`）。群の店の円を、範囲の索引で引く箱へ広げる。
_DEGREES_PER_M = degrees_covering_m(1.0)

#: 子午線の曲率半径の下限（m）。WGS84 の赤道での値 a(1−e²)（約 6,335,439m）より小さく丸め、緯度の帯を計算の誤差の分だけ広げる。
_MERIDIAN_RADIUS_LOWER_M = 6_335_000

# 整えると空になる入力（中点・ハイフンだけ）は、空の文字列がどの名前にも含まれるので名前では引かない。
# 近さは測地の距離で測る（度のままの距離は、関東の緯度で東西を2割ほど短く数える）。並びの最後の鍵は、同じ位置の店の
# 並びを毎回同じにするため。
# 文は接続ごとに準備して使い回されるので、入力の値を知らない一般の計画でも速い形にしてある:
# - 整えた入力・LIKE の型・中心は副問い合わせにして、行ごとでなく1回だけ求める。
# - 群・チェーン・名前の当たり方ごとに、それぞれの索引で引いてからまとめる。1つの OR でつなぐと、どの索引も使えず全行を読む
#   （関東の約104万行で1回 0.3〜0.8秒）。部分一致と頭の一致はどちらか一方だけが行を返す（`:contains`）。頭の一致は照合順序`C`の
#   範囲で引く——LIKE の頭の一致を索引で引けるのは型が定数のときだけで、一般の計画では全行を読む。群・チェーンの分は、
#   入力が群・チェーンの語でなければ（値が NULL）入口で外す——一般の計画では`= NULL`が畳まれず、索引をたどって全行を捨てる。
# - 群の店は数十万あるので全部は引かず、位置の部分索引で平面の近い順に上限の件数を引き（`group_near`）、その中の最も遠い測地の
#   距離の円の中の群の店だけを候補にする。その円の中に上限の件数の店があるので、測地の距離で近い上限の件数の店は全部その円に入る。
#   近い順に引く所は範囲を素の`&&`で書く——式で包むと当たる行を数行と見積もり、群の店を全部引いてから並べる計画になる。円は
#   1m 広げる（円の端の店が、距離の求め方の違いで円から外れないように）。
# - 範囲は列を式で包んで`&&`で比べ、範囲の索引を選ばせない。範囲は表のほぼ全部に当たるのに、一般の計画は当たる行を少なく
#   見積もって索引でたどる。座標の大小で比べないのは、`&&`が箱を float4 へ外へ丸めて比べ、範囲の境の外の点も入れるため。
# - 測地の距離は、候補に入りうる行にだけ求める。平面の近さで上限の件数を選んで測地の距離を求め、その最大を上限の件数目の
#   距離の上限にする。測地の距離は緯度の差の子午線の弧より短くならないので、緯度の差がその上限に届かない行だけを並べ直せば、
#   全部の行に測地の距離を求めて並べたのと同じ答えになる。
_SEARCH_SQL = text(f"""
    WITH q AS (
        SELECT n.name, {like_escaped_sql("n.name")} AS pattern,
               ST_SetSRID(ST_MakePoint(:near_lon, :near_lat), 4326)::geography AS center
        FROM (SELECT {normalized_sql(":query")} AS name) n
    ),
    group_near AS (
        SELECT ST_Distance(s.geom::geography, (SELECT center FROM q)) AS distance
        FROM places s
        WHERE CAST(:place_group AS varchar) IS NOT NULL AND s.place_group = CAST(:place_group AS varchar)
          AND NOT {search_excluded_sql("s.categories")}
          AND s.geom && ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326)
        ORDER BY s.geom <-> ST_SetSRID(ST_MakePoint(:near_lon, :near_lat), 4326)
        LIMIT :limit
    ),
    matched AS (
        SELECT s.* FROM places s, (SELECT max(distance) AS distance FROM group_near) r
        WHERE s.place_group = CAST(:place_group AS varchar)
          AND s.geom && ST_Expand(ST_SetSRID(ST_MakePoint(:near_lon, :near_lat), 4326), (r.distance + 1) * {_DEGREES_PER_M})
          AND ST_DWithin(s.geom::geography, (SELECT center FROM q), r.distance + 1)
        UNION ALL
        SELECT s.* FROM places s WHERE CAST(:chain AS varchar) IS NOT NULL AND s.chain = CAST(:chain AS varchar)
        UNION ALL
        SELECT s.* FROM places s
        WHERE CAST(:contains AS boolean) AND s.search_name LIKE '%' || (SELECT pattern FROM q) || '%'
        UNION ALL
        SELECT s.* FROM places s
        WHERE NOT CAST(:contains AS boolean) AND (SELECT name FROM q) <> ''
          AND s.search_name COLLATE "C" >= (SELECT name FROM q)
          AND s.search_name COLLATE "C" < (SELECT name FROM q) || chr(1114111)
    ),
    hit AS MATERIALIZED (
        SELECT DISTINCT ON (s.source, s.source_key) s.name, s.area, s.geom, s.source, s.source_key,
               {match_rank_sql("s.place_group", "CAST(:place_group AS varchar)", "s.chain", "CAST(:chain AS varchar)",
                               "s.search_name", "(SELECT name FROM q)")} AS rank
        FROM matched s
        WHERE NOT {search_excluded_sql("s.categories")}
          AND ST_Force2D(s.geom) && ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326)
    ),
    nearest AS (
        SELECT rank, ST_Distance(geom::geography, (SELECT center FROM q)) AS distance
        FROM hit
        ORDER BY rank, ((ST_X(geom) - :near_lon) * cos(radians(:near_lat))) ^ 2 + (ST_Y(geom) - :near_lat) ^ 2
        LIMIT :limit
    ),
    bound AS (SELECT rank, max(distance) AS distance FROM nearest GROUP BY rank ORDER BY rank DESC LIMIT 1)
    SELECT h.name, h.area, ST_Y(h.geom) AS latitude, ST_X(h.geom) AS longitude
    FROM hit h, bound b
    WHERE h.rank < b.rank
       OR (h.rank = b.rank AND abs(ST_Y(h.geom) - :near_lat) <= degrees(b.distance / {_MERIDIAN_RADIUS_LOWER_M}))
    ORDER BY h.rank, ST_Distance(h.geom::geography, (SELECT center FROM q)), h.source, h.source_key
    LIMIT :limit
""")



class FacilitySearchQuery:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def search(self, query: str, area: BoundingBox, near: LatLon) -> list[PlaceCandidate]:
        """対象範囲の中で、入力が群の語ならその群の店、チェーンの語ならそのチェーンの店と、名前に入力を含む（短い入力は、
        名前が入力で始まる）施設を
        `PLACE_PREDICTION_LIMIT`件まで。並びは、群・チェーンの店 → 名前が入力と同じ → 入力で始まる → 入力を含む、同じ中では
        `near`に近い順——同じ名前の店が上限を超えても、`near`の近くの店が入る。"""
        group = queried_group(query)
        rows = (await self._session.execute(_SEARCH_SQL, {
            "query": query, "place_group": group.value if group else None, "chain": queried_chain(query),
            "contains": len(normalized_form(query)) >= CONTAINS_MIN_LENGTH,
            "min_lat": area.min_latitude, "min_lon": area.min_longitude,
            "max_lat": area.max_latitude, "max_lon": area.max_longitude,
            "near_lat": near.latitude, "near_lon": near.longitude,
            "limit": PLACE_PREDICTION_LIMIT,
        })).mappings()
        return [
            PlaceCandidate(kind="facility", level="point", name=row["name"], area=row["area"],
                           latitude=row["latitude"], longitude=row["longitude"])
            for row in rows
        ]
