"""地図の路面タイル（MVT）を焼くSQLと、道の名前を引くSQL。焼くフィーチャーとその形は引数で受け、ここではフィーチャーを選ばない。"""

from sqlalchemy import text

from app.domain.region import ROAD_TILE_MIN_ZOOM
from app.infrastructure.cache_identity import shape_digest
from app.infrastructure.source_models import COVERAGE_SQL, ways_lookup_sql
from app.infrastructure.vector_tile import ROAD_FEATURE_PROPERTIES, TILE_BUFFER

#: 道路名・路線番号の生値（OSM の`name`・`ref`）。空は値が無いものとして出す。
_NAME_SQL = "NULLIF(btrim(w.tags->>'name'), '')"
_REF_SQL = "NULLIF(btrim(w.tags->>'ref'), '')"

# 路面タイル（MVT）をPostGIS側で丸ごと生成する。転送は完成済みタイル1個で済み、枠で切るのとエンコードはPostGISのC実装が担う
# （Pythonで地物を1つずつ切って焼くと、引いたズームで数倍遅い）。
#
# フィーチャーは鍵（`:keys`）と線の形（`:shapes`。経度・緯度の WKB）を同じ並びの配列で受ける。焼くのは地図が塗るものだけ: 線の形と、
# 地図の線の層の値と当たる0次ハードフィルタ（`:layer_values`。`feature_key`→層のid→値のJSON。値の無い道は載らない）。層の値は
# jsonbの列のまま渡し、ST_AsMVTが層のidごとのプロパティに広げる。`ROAD_TILE_MIN_ZOOM`以上は道ごとの鍵（`feature_key`。地図が道ごとの
# 値を置く）も焼き、それより引いたズームは層の値が同じ道を1つにつなぐ（道ごとの鍵が要らず、線の本数と点が減る）。つなぐのはタイルの
# 座標へ写した後の形で、タイルの外へ出た所は切れたまま。
#
# カバレッジ判定も同じクエリへ畳み込み、1タイルあたりのDB往復を1回にする。CASE式は条件が
# falseの分岐を評価しないため、カバレッジ外ではMVT生成のサブクエリ自体が実行されない。
ROAD_SURFACE_TILE_MVT_SQL = text(
    f"""
    WITH coverage AS ({COVERAGE_SQL}),
    layer_values AS (SELECT key AS feature_key, value AS layers FROM jsonb_each(CAST(:layer_values AS jsonb))),
    features AS NOT MATERIALIZED (
        SELECT
            ST_AsMVTGeom(
                ST_Transform(ST_GeomFromWKB(src.shape, 4326), 3857), ST_TileEnvelope(:z, :x, :y), :extent, {TILE_BUFFER}, true
            ) AS geom,
            src.feature_key,
            layer_values.layers
        FROM unnest(CAST(:keys AS text[]), CAST(:shapes AS bytea[])) AS src(feature_key, shape)
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


#: 道の番号（`:ids`）ごとの道路名・路線番号。**第三者が編集できる生値で対訳表を持たない**ため、表示に埋め込む側は必ずエスケープする。
#: 道の生データに無い道は行を返さない。
WAY_NAMES_SQL = text(
    f"""
    SELECT ids.osm_way_id, {_NAME_SQL} AS name, {_REF_SQL} AS ref
    FROM unnest(CAST(:ids AS bigint[])) AS ids(osm_way_id)
    JOIN LATERAL {ways_lookup_sql('ids.osm_way_id')} w ON true
    """
)


#: タイルのディスク／Redisキャッシュの鍵に入る**形の署名**。焼き込むSQLから導出するため、
#: 列や分類タグを変えれば自動的に別の鍵になる。DBの中身が作り直されたことは署名では表せない。
ROAD_SURFACE_TILE_SHAPE = shape_digest(ROAD_SURFACE_TILE_MVT_SQL)
