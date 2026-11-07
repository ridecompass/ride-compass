"""地図のタイル（路面のMVT）と、タイルと同じフィーチャーごとに値を配る読み出しのSQL。

どの読み出しも、フィーチャーの並びを`_TILE_FEATURE_SOURCE_SQL`から引き、鍵は路面のタイルが焼く`feature_key`と同じものになる。
"""

from collections.abc import Iterable

from sqlalchemy import text

from app.domain.geo import bearing_sql, midpoint_sql
from app.domain.graph import edge_feature_key_sql
from app.domain.material_catalog import (
    material_tile_columns,
    material_value_sql,
)
from app.domain.region import EDGE_UNIT_MIN_ZOOM, ROAD_TILE_MIN_ZOOM
from app.infrastructure.cache_identity import shape_digest
from app.infrastructure.material_joins import material_from_clause
from app.infrastructure.source_models import COVERAGE_SQL, WAYS_SOURCE_SQL, ways_lookup_sql
from app.infrastructure.vector_tile import ROAD_FEATURE_PROPERTIES, TILE_BUFFER

#: どちらの単位も`feature_key`という同じ名前で出し、受け取る側は中身がway_idか区間の鍵かを知らなくてよい。
#:
#: 空間フィルタは各枝の中に置く。外へ出すとroad_edges全件に対して走り、タイルの中身に
#: 依存しない固定コストになる。
_TILE_FEATURE_SOURCE_SQL = f"""
    SELECT
        w2.geom AS geom,
        w2.osm_way_id AS osm_way_id,
        NULL::smallint AS segment_index,
        w2.osm_way_id::text AS feature_key,
        NULL::double precision AS length_m
    FROM {WAYS_SOURCE_SQL} w2
    WHERE :z < {EDGE_UNIT_MIN_ZOOM}
      AND ST_Intersects(w2.geom, ST_MakeEnvelope(:xmin, :ymin, :xmax, :ymax, 4326))
    UNION ALL
    SELECT
        re.geom,
        re.osm_way_id,
        re.segment_index,
        {edge_feature_key_sql("re.osm_way_id", "re.segment_index")},
        -- 密度（件/km）の分母。way全体ではなくこの区間の長さで割る。
        re.distance_m
    FROM road_edges re
    WHERE :z >= {EDGE_UNIT_MIN_ZOOM}
      AND ST_Intersects(re.geom, ST_MakeEnvelope(:xmin, :ymin, :xmax, :ymax, 4326))
    UNION ALL
    -- 区間を1本も持たないway（同じ位置に点が重なり長さ0の区間しか作れないway等）は、区間単位の
    -- ズームでもway丸ごとで出す。**落とすと、その道はズームを上げたときだけ地図から
    -- 消える**——引いた表示には出ているのに拡大すると無くなる見え方は、データが無いこと
    -- よりも壊れて見える。
    SELECT
        w3.geom, w3.osm_way_id, NULL::smallint, w3.osm_way_id::text, NULL::double precision
    FROM {WAYS_SOURCE_SQL} w3
    WHERE :z >= {EDGE_UNIT_MIN_ZOOM}
      AND ST_Intersects(w3.geom, ST_MakeEnvelope(:xmin, :ymin, :xmax, :ymax, 4326))
      AND NOT EXISTS (SELECT 1 FROM road_edges re2 WHERE re2.osm_way_id = w3.osm_way_id)
"""
#: フィーチャー（`_TILE_FEATURE_SOURCE_SQL`の行`src`）の始点と終点で決める中点と方位。
_FEATURE_MIDPOINT_SQL = midpoint_sql("ST_StartPoint(src.geom)", "ST_EndPoint(src.geom)")
_FEATURE_BEARING_SQL = bearing_sql("ST_StartPoint(src.geom)", "ST_EndPoint(src.geom)")


#: 材料の焼き込み列。`tile_property`を持つ全材料について、値式から組んだ式を並べる
#: （`domain/material_catalog.py: material_tile_columns`）。列を手で書くと、地図と評価が別々の求め方になる。
_MATERIAL_TILE_COLUMNS_SQL = ",\n".join(
    f"                    {expression} AS {tile_property}"
    for tile_property, expression in material_tile_columns().items()
)

def _tile_material_joins(expressions: Iterable[str]) -> str:
    """フィーチャー（別名`src`）が`expressions`の値式を読むためのJOIN。値式が読む別名（`w`・`wm`・`em`・`re`）を
    フィーチャーの単位で与え、区間でもway丸ごとでも同じ値式を使う。`em`は区間単位のフィーチャーなら区間の値、
    way丸ごとなら道1本の値で、件数と長さ（`re`）は必ず同じ側から取る——片方だけ区間にすると、区間の件数を
    way全体の長さで割った無意味な値になる。`re`は長さだけを持ち、way丸ごとのフィーチャーはwayの長さ（0はNULL）にする。
    """
    return f"""
                    JOIN LATERAL {ways_lookup_sql('src.osm_way_id')} w ON true
                    {material_from_clause(expressions, 'src.osm_way_id',
                                          'src.segment_index', way_when_no_segment=True)}
                    CROSS JOIN LATERAL (
                        -- `OFFSET 0`は外へ畳ませないためのもの——畳まれると`re.distance_m`を読む
                        -- 値式ごとに道の長さを測り直す。
                        SELECT CASE WHEN src.segment_index IS NOT NULL THEN src.length_m
                                    ELSE NULLIF(ST_Length(w.geom::geography), 0) END AS distance_m
                        OFFSET 0
                    ) re
"""

#: 押した所に近い道（`ROADS_AT_SQL`）がフィーチャー（別名`src`）ごとに返すプロパティの列。地図の小窓が読む。
_FEATURE_PROPERTY_COLUMNS_SQL = f"""                    src.feature_key AS {ROAD_FEATURE_PROPERTIES['feature_key']},
                    -- 道の窓が、ポップアップに出た値と同じ行を曖昧さ無く引き
                    -- 直すための識別子。空間マッチ（半径内最近傍）だと交差点付近で別の
                    -- 道路を拾いうる。
                    w.osm_way_id AS {ROAD_FEATURE_PROPERTIES['way_id']},
                    -- 道路名・路線番号（表示専用）。材料の正規化はかけない——利用者へ
                    -- そのまま見せる固有名詞のため。**第三者が編集できる生値で対訳表を
                    -- 持たない**ため、埋め込む側は必ずエスケープする。
                    NULLIF(btrim(w.tags->>'name'), '') AS {ROAD_FEATURE_PROPERTIES['name']},
                    NULLIF(btrim(w.tags->>'ref'), '') AS {ROAD_FEATURE_PROPERTIES['ref']},
{_MATERIAL_TILE_COLUMNS_SQL}"""
_FEATURE_PROPERTY_JOINS_SQL = _tile_material_joins(material_tile_columns().values())

# 路面タイル（MVT）をPostGIS側で丸ごと生成する。転送は完成済みタイル1個で済み、エンコードはPostGISのC実装が担う。
# bbox内の全way行をPythonへ転送してshapelyでdecode→encodeする構成だと、行転送とGILを握るCPU処理で数秒かかる。
#
# 焼くのは地図が塗るものだけ: 線の形と、地図の線の層の値（`:layer_values`。`feature_key`→層のid→値のJSON。値の無い道は
# 載らない）。層の値はjsonbの列のまま渡し、ST_AsMVTが層のidごとのプロパティに広げる。`ROAD_TILE_MIN_ZOOM`以上は道ごとの
# 鍵（`feature_key`。地図が道ごとの値を置く）も焼き、それより引いたズームは層の値が同じ道を1つにつなぐ（道ごとの鍵が要らず、
# 線の本数と点が減る）。つなぐのはタイルの座標へ写した後の形で、タイルの外へ出た所は切れたまま。
#
# カバレッジ判定も同じクエリへ畳み込み、1タイルあたりのDB往復を1回にする。CASE式は条件が
# falseの分岐を評価しないため、カバレッジ外ではMVT生成のサブクエリ自体が実行されない。
ROAD_SURFACE_TILE_MVT_SQL = text(
    f"""
    WITH coverage AS ({COVERAGE_SQL}),
    layer_values AS (SELECT key AS feature_key, value AS layers FROM jsonb_each(CAST(:layer_values AS jsonb))),
    features AS (
        SELECT
            ST_AsMVTGeom(
                ST_Transform(src.geom, 3857), ST_TileEnvelope(:z, :x, :y), :extent, {TILE_BUFFER}, true
            ) AS geom,
            src.feature_key,
            layer_values.layers
        FROM ({_TILE_FEATURE_SOURCE_SQL}) src
        LEFT JOIN layer_values ON layer_values.feature_key = src.feature_key
    )
    SELECT
        coverage.covered,
        CASE WHEN coverage.covered THEN (
            SELECT ST_AsMVT(mvt.*, :layer_name, :extent, 'geom') FROM (
                SELECT geom, feature_key AS {ROAD_FEATURE_PROPERTIES['feature_key']}, layers
                FROM features
                WHERE :z >= {ROAD_TILE_MIN_ZOOM} AND geom IS NOT NULL
                UNION ALL
                SELECT ST_LineMerge(ST_Collect(geom)), NULL, layers
                FROM features
                WHERE :z < {ROAD_TILE_MIN_ZOOM} AND geom IS NOT NULL
                GROUP BY layers
            ) mvt
        ) END AS tile
    FROM coverage
    """
)


# 押した所（`:lon`, `:lat`）から`:radius_m`以内の道のフィーチャーを、近い順に`:limit`本。フィーチャーの並び・単位
# （ズーム`:z`で区間か道1本か）とプロパティの列は路面タイルと同じものを使う——地図が塗る線と押して開く小窓が、同じ
# 鍵・同じ値を指す。`:xmin`〜`:ymax`は半径を覆う箱（空間の索引で絞るための前置フィルタ）で、距離そのものは地面の m で測る。
# 形はタイルで切らない、そのフィーチャーの線の全体（押した物を強調し、小窓をかぶらない側に置くのに使う）。
ROADS_AT_SQL = text(
    f"""
    SELECT
        ST_AsGeoJSON(src.geom) AS shape,
{_FEATURE_PROPERTY_COLUMNS_SQL}
    FROM (
        SELECT near.*, ST_Distance(near.geom::geography, pressed.geog) AS pressed_distance_m
        FROM ({_TILE_FEATURE_SOURCE_SQL}) near
        CROSS JOIN (SELECT ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography AS geog) pressed
        WHERE ST_DWithin(near.geom::geography, pressed.geog, :radius_m)
        ORDER BY pressed_distance_m, near.feature_key
        LIMIT :limit
    ) src
    {_FEATURE_PROPERTY_JOINS_SQL}
    ORDER BY src.pressed_distance_m, src.feature_key
    """
)


# 鍵→フィーチャーごとの材料（地図の道の線の層の値）。**タイルと同じソース**から鍵の一覧を引く。
# 別に組み立てると、単位の切り替わり方がタイルとずれた瞬間に鍵が噛み合わず、色が一切
# 付かない。
_FEATURE_MATERIAL_EXPRESSIONS = dict(sorted(material_value_sql().items()))
FEATURE_MATERIALS_IN_TILE_SQL = text(
    f"""
    WITH coverage AS ({COVERAGE_SQL})
    SELECT
        coverage.covered,
        array_agg(f.feature_key ORDER BY f.ord) FILTER (WHERE f.ord IS NOT NULL) AS feature_keys,
        {", ".join(f"array_agg(f.m_{material_id} ORDER BY f.ord) FILTER (WHERE f.ord IS NOT NULL) AS c_{material_id}"
                   for material_id in _FEATURE_MATERIAL_EXPRESSIONS)}
    FROM coverage
    LEFT JOIN LATERAL (
        SELECT
            src.feature_key,
            row_number() OVER () AS ord,
            {", ".join(f"({expression}) AS m_{material_id}"
                       for material_id, expression in _FEATURE_MATERIAL_EXPRESSIONS.items())}
        FROM ({_TILE_FEATURE_SOURCE_SQL}) src
        {_tile_material_joins(_FEATURE_MATERIAL_EXPRESSIONS.values())}
        WHERE coverage.covered
    ) f ON true
    GROUP BY coverage.covered
    """
)


#: タイルのディスク／Redisキャッシュの鍵に入る**形の署名**。焼き込むSQLから導出するため、
#: 列や分類タグを変えれば自動的に別の鍵になる。DBの中身が作り直されたことは署名では表せない。
ROAD_SURFACE_TILE_SHAPE = shape_digest(ROAD_SURFACE_TILE_MVT_SQL)
#: 勾配の入力を取り出すSQLの形の署名。勾配のタイル値のキャッシュの鍵に入る。
#: フィーチャーごとの材料を読むSQLの形の署名。材料のタイル値のキャッシュの鍵に入る。
FEATURE_MATERIALS_SHAPE = shape_digest(FEATURE_MATERIALS_IN_TILE_SQL)
