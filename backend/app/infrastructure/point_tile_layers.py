"""点データのタイル（停止要因・補給休憩のPOI・事故・立ち寄り先）のレイヤーの宣言。

レイヤーごとに違うのは焼き込むSQLとsource-layer名だけで、点のレイヤーを足すのはここへ1エントリ足すことだけである。

どのSQLも`(covered, tile)`の1行を返す。取込範囲を判定するレイヤーは`source_models.py: COVERAGE_SQL`を
読み、判定しないレイヤー（事故・立ち寄り先は対象範囲を一括で取り込むため「範囲の一部だけ取得済み」が無い）は`covered`を
常に真にする。`:layer_name`・`:extent`・タイル座標（`:z`・`:x`・`:y`・`:xmin`等）は読み出しの側が渡す。

どのレイヤーも、タイルの中の近い点を凡例の行ごとに1つの代表点へ束ねて焼き、代表点は束ねた点の数
（`domain/map_display.py: POINT_COUNT_PROPERTY`）と、2点以上なら束ねた名前のある点の名前と位置
（`domain/map_display.py: POINT_MEMBERS_PROPERTY`）を持つ。
"""

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from functools import cached_property

from sqlalchemy import BindParameter, Float, Integer, Text, TextClause, bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY

from app.domain.accident import BICYCLE_SQL, FATAL_SQL
from app.domain.geo import degrees_covering_m
from app.domain.map_display import POINT_CLUSTER_CELLS_PER_TILE, point_cluster_sql
from app.domain.primary_attributes import PRIMARY_ATTRIBUTES, SUPPLY_PLACE_GROUPS, stop_poi_map_group_sql
from app.domain.registry import PrimaryAttributeSpec, TileKind
from app.domain.stop_place import StopPlaceGroup
from app.domain.traffic import SIGNAL_KIND, STOP_CLUSTER_REACH_STEPS, STOP_POI_KINDS, stop_cluster_sql, stop_kind_sql
from app.domain.tuning import STOP_CLUSTER_DISTANCE_ID
from app.infrastructure.cache_identity import shape_digest
from app.infrastructure.derived_data_meta import recorded_tuning_sql
from app.infrastructure.derived_models import grouped_place_sql
from app.infrastructure.source_models import COVERAGE_SQL, NODES_SOURCE_SQL, accidents_within_sql
from app.infrastructure.vector_tile import ROAD_SURFACE_LAYER_NAME, TILE_BUFFER


@dataclass(frozen=True)
class PointTileLayer:
    #: 配信のパス・キャッシュのパスに入る名前。一次属性の`tile_kind`はこの名前を指す。
    name: TileKind
    #: タイルの中のレイヤー名（MapLibreのsource-layer）。空タイルもこの名前を名乗る。
    source_layer: str
    sql: TextClause

    @cached_property
    def shape(self) -> str:
        """タイルの世代に入る形の署名。source-layer名を変えても鍵が変わる（古い名前のタイルを配らない）。"""
        return shape_digest(self.sql, self.source_layer)


def _place_groups_param(groups: Iterable[StopPlaceGroup]) -> BindParameter[Sequence[str]]:
    """タイルが地点の表から出す群`groups`（`:place_groups`）。"""
    return bindparam("place_groups", value=sorted(groups), type_=ARRAY(Text()))


# 地点の表は、位置の部分索引の条件（`derived_models.py: grouped_place_sql`）で絞ってから、タイルが出す群で選ぶ。
_PLACE_POINTS_WHERE = f"""{grouped_place_sql("s")} AND s.place_group = ANY(:place_groups)
              AND ST_Intersects(s.geom, ST_MakeEnvelope(:xmin, :ymin, :xmax, :ymax, 4326))"""

_CLUSTER_PARAMS = (bindparam("cluster_cells", value=POINT_CLUSTER_CELLS_PER_TILE, type_=Integer()),)


_TILE_ENVELOPE = "ST_TileEnvelope(:z, :x, :y)"


def _clustered_mvt_sql(points: str, rows: tuple[str, ...], properties: tuple[str, ...], preference: str) -> str:
    """タイルの中の点`points`を代表点へ束ねて（`domain/map_display.py: point_cluster_sql`）1タイルへ焼くSQL式。"""
    clustered = point_cluster_sql(
        points, _TILE_ENVELOPE, ":cluster_cells", rows, properties, preference,
        place=lambda geom: f"ST_AsMVTGeom({geom}, {_TILE_ENVELOPE}, :extent, {TILE_BUFFER}, true)")
    return f"""(
        SELECT ST_AsMVT(mvt.*, :layer_name, :extent, 'geom') FROM ({clustered}) mvt
        WHERE mvt.geom IS NOT NULL
    )"""


# 種別は`node_kinds.kind`（派生側の分類器が付けたもの）に信号の読み替えを済ませたもので、
# 位置は`source_features`の点。コンビニだけは地点の表（`places`）の群「コンビニ」の行から足し、店の名前も添える。
_POI_KIND_EXPR = stop_kind_sql("nm", "sp.place_id")
_POI_GROUP_EXPR = stop_poi_map_group_sql("nm", "sp.place_id")

#: 地面の1mを覆う度。クラスタ化のためにタイルの外側も読む幅は、まとめる距離からSQLの中で作る。
_DEGREES_PER_M = degrees_covering_m(1.0)

# 停止要因POI・補給POIを1タイルへ焼き込む。信号は交差点の段の信号の交差点（`signal_places`）に1点で出し、ほかの停止要因は
# 派生を作り直したときのまとめる距離で`domain/traffic.py: stop_cluster_sql`でまとめてから、ほかの点と同じく升目で束ねる。タイル境界で塊が切れると
# 同じ交差点が隣り合うタイルで別々の点になるので、境目の外をまとめる距離の`domain/traffic.py: STOP_CLUSTER_REACH_STEPS`倍まで読む（式の間隔は地面のmを
# 下回らないので、地面のmで覆えば足りる）。
_POI_POINTS_SQL = f"""
    SELECT grouped.kind, grouped.map_group, grouped.name, grouped.geom
    FROM (
        -- まとめた点の種別はどれを代表にしても凡例の同じ行に入る。
        SELECT min(clustered.kind) AS kind,
               clustered.map_group,
               min(clustered.name) AS name,
               ST_Centroid(ST_Collect(clustered.geom)) AS geom
        FROM (
            SELECT {_POI_KIND_EXPR} AS kind,
                   {_POI_GROUP_EXPR} AS map_group,
                   CASE WHEN {_POI_KIND_EXPR} = '{SIGNAL_KIND}' THEN pl.geom ELSE p.geom END AS geom,
                   -- 停止要因はまとめてから出す（同じ交差点が複数の点に
                   -- ならないように）。補給POIは別々の実体なのでまとめない。
                   CASE WHEN {_POI_KIND_EXPR} = '{SIGNAL_KIND}' THEN 'p' || sp.place_id
                        WHEN nm.kind = ANY(:stop_kinds) THEN
                       'c' || {stop_cluster_sql("p.geom", "(SELECT eps_m FROM cluster)", _POI_GROUP_EXPR)}
                   ELSE 'n' || p.osm_node_id END AS cluster_key,
                   NULL::text AS name
            FROM {NODES_SOURCE_SQL} p
            JOIN node_kinds nm ON nm.osm_node_id = p.osm_node_id
            LEFT JOIN signal_place_nodes sp ON sp.osm_node_id = p.osm_node_id
            LEFT JOIN signal_places pl ON pl.place_id = sp.place_id
            WHERE ST_Intersects(
                  p.geom,
                  ST_Expand(
                      ST_MakeEnvelope(:xmin, :ymin, :xmax, :ymax, 4326),
                      (SELECT {STOP_CLUSTER_REACH_STEPS} * eps_m * :degrees_per_m FROM cluster)))
            UNION ALL
            -- 補給POIの凡例の行に入る立ち寄り先の群（コンビニ）は地点の表から出す。群の値が種別の値。
            SELECT s.place_group, s.place_group, s.geom,
                   's' || s.source || ':' || s.source_key, s.name
            FROM places s
            WHERE {_PLACE_POINTS_WHERE}
        ) clustered
        GROUP BY clustered.map_group, clustered.cluster_key
    ) grouped
    WHERE ST_Intersects(grouped.geom, ST_MakeEnvelope(:xmin, :ymin, :xmax, :ymax, 4326))
"""

_POI_CLUSTERED_SQL = _clustered_mvt_sql(_POI_POINTS_SQL, rows=("map_group",), properties=("kind",), preference="celled.kind")

_POI_TILE_MVT_SQL = text(
    f"""
    WITH coverage AS ({COVERAGE_SQL}),
    cluster AS (SELECT {recorded_tuning_sql(STOP_CLUSTER_DISTANCE_ID)} AS eps_m)
    SELECT
        coverage.covered,
        CASE WHEN coverage.covered THEN {_POI_CLUSTERED_SQL} END AS tile
    FROM coverage
    """
).bindparams(
    bindparam("stop_kinds", value=sorted(STOP_POI_KINDS), type_=ARRAY(Text())),
    bindparam("degrees_per_m", value=_DEGREES_PER_M, type_=Float()),
    _place_groups_param(SUPPLY_PLACE_GROUPS),
    *_CLUSTER_PARAMS,
)

# 事故。表示に使う値（死亡事故か・自転車が絡むか・発生年）は生データの列から都度導く。判定の
# 規則は`domain/accident.py`が持つ。束ねた代表点は、一番新しい事故の発生年を持つ。
_ACCIDENT_POINTS_SQL = f"""
    SELECT a.geom, NULL::text AS name, {BICYCLE_SQL} AS involves_bicycle, {FATAL_SQL} AS fatal, a.occurred_year
    FROM {accidents_within_sql("ST_MakeEnvelope(:xmin, :ymin, :xmax, :ymax, 4326)")} a
"""

_ACCIDENT_CLUSTERED_SQL = _clustered_mvt_sql(
    _ACCIDENT_POINTS_SQL,
    rows=("involves_bicycle", "fatal"),
    properties=("involves_bicycle", "fatal", "occurred_year"),
    preference="celled.occurred_year DESC NULLS LAST",
)

_ACCIDENT_TILE_MVT_SQL = text(
    f"""
    SELECT
        true AS covered,
        {_ACCIDENT_CLUSTERED_SQL} AS tile
    """
).bindparams(*_CLUSTER_PARAMS)

# 立ち寄り先。地点の表（`batch/derive_places.py`）のうち、補給の点のタイルが出さない群の行をそのまま出す。代表点は確からしい
# 地点を先に選ぶ。
_STOP_PLACE_POINTS_SQL = f"""
    SELECT s.geom, s.name, s.place_group AS "group", s.confidence
    FROM places s
    WHERE {_PLACE_POINTS_WHERE}
"""

_STOP_PLACE_CLUSTERED_SQL = _clustered_mvt_sql(
    _STOP_PLACE_POINTS_SQL, rows=('"group"',), properties=('"group"',), preference="celled.confidence DESC NULLS LAST"
)

_STOP_PLACE_TILE_MVT_SQL = text(
    f"""
    SELECT
        true AS covered,
        {_STOP_PLACE_CLUSTERED_SQL} AS tile
    """
).bindparams(_place_groups_param(set(StopPlaceGroup) - SUPPLY_PLACE_GROUPS), *_CLUSTER_PARAMS)

#: 名前→点のレイヤー。
POINT_TILE_LAYERS: dict[str, PointTileLayer] = {
    layer.name: layer
    for layer in (
        PointTileLayer(name="poi", source_layer="stop_poi", sql=_POI_TILE_MVT_SQL),
        PointTileLayer(name="accident", source_layer="accidents", sql=_ACCIDENT_TILE_MVT_SQL),
        PointTileLayer(name="stop_place", source_layer="stop_places", sql=_STOP_PLACE_TILE_MVT_SQL),
    )
}


def check_point_tile_layers(layers: Mapping[str, PointTileLayer], attributes: Iterable[PrimaryAttributeSpec]) -> None:
    """点の一次属性を配らない・タイルの中のレイヤーを取り違える宣言を断る。

    地図に点として出す一次属性が指す系統が宣言に無いと、画面はその点のタイルを要求できない。source-layer名を道路の
    タイルや別のレイヤーと同じにすると、画面がタイルの中のレイヤーを取り違える。
    """
    unserved = {
        a.tile_kind for a in attributes if a.geometry == "point" and a.tile_kind is not None and a.tile_kind not in layers
    }
    if unserved:
        raise ValueError(f"点の一次属性が指す系統{unserved}を配るレイヤーが無い")
    names = [ROAD_SURFACE_LAYER_NAME, *(layer.source_layer for layer in layers.values())]
    if len(set(names)) != len(names):
        raise ValueError(f"source-layer名が重なる: {names}")


check_point_tile_layers(POINT_TILE_LAYERS, PRIMARY_ATTRIBUTES)
