"""Road Graph・材料の読み出し（PostGIS）。

**読み取り専用**。書き込むのは`app/batch/`の取込（`ingest_cli.py`）と派生
（`derive_cli.py`）だけで、web側は作らない。取込の範囲が決まっているぶん、ここには
「無ければ作る」経路が無い。

区間（`road_edges`）は向きを持たない1本1行で、有向の枝は探索がメモリ上で組む。DBへ
向きを伝えるのは`(osm_way_id, segment_index, forward)`の3つ組で、向きで変わる値
（方位・標高）はSQLが入れ替え・符号反転して返す。

材料の値の求め方は`domain/material_sql.py`と`domain/material_catalog.py`が持つ。ここは
式が前提にする別名（`w`/`re`/`em`/`wm`）のFROM句を組み立てるだけで、式を書かない。
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Mapping, Sequence
from itertools import batched

import numpy as np
import shapely
from sqlalchemy import Row, TextClause, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.domain.attributes import CategoricalColumn, EdgeMaterialArrays, MaterialColumn
from app.domain.feature_materials import FeatureMaterials
from app.domain.geo import bearing_sql, degrees_covering_m, midpoint_sql
from app.domain.graph import LeanEdge, edge_key, node_key
from app.domain.material_catalog import (
    material_array_columns,
    material_value_sql,
)
from app.domain.region import BoundingBox, RoadAt
from app.domain.tuning import TURN_BEARING_DISTANCE_ID
from app.infrastructure import derived_data_meta
from app.infrastructure.material_joins import material_from_clause
from app.infrastructure.orm_base import declared_metadata
from app.infrastructure.road_tile_sql import (
    FEATURE_MATERIALS_IN_TILE_SQL,
    ROAD_SURFACE_TILE_MVT_SQL,
    ROADS_AT_SQL,
)
from app.infrastructure.source_models import (
    COVERAGE_SQL,
    INGESTED_BBOX_SQL,
    Source,
    nodes_lookup_sql,
    ways_lookup_sql,
)
from app.infrastructure.vector_tile import ROAD_SURFACE_LAYER_NAME, TILE_EXTENT

logger = logging.getLogger("ridecompass.road_graph_repository")

#: 1文へ載せるidの数。1配列=1パラメータなので上限ではなく転送量の都合で切る。
ID_CHUNK_SIZE = 50_000


#: スキーマが依存する拡張。**アプリの権限では入れられない**（どちらもスーパーユーザーを
#: 要求し、trustedでもない）ため、DBを作る人が先に入れる。`raster`は面のソースの列の型で、
#: 画素の数え上げをDB側で行うために要る。
REQUIRED_EXTENSIONS = ("postgis", "postgis_raster")


async def create_tables(engine: AsyncEngine) -> None:
    """ORMが宣言するスキーマを作る（まっさらなDB向け）。

    実DBとの差は`backend/scripts/schema_gap.py`が測る。積み上げ式のmigrationは持たない
    ——正本は実DBで、ORMの宣言は「あるべき姿」である。

    拡張は**入れずに要求する**。入れるふりをすると、権限が無い環境で「機能拡張を作成する
    権限がありません」とだけ出て、何をすればよいかが伝わらない。
    """
    async with engine.begin() as conn:
        installed: set[str] = set(
            (await conn.execute(text("SELECT extname FROM pg_extension"))).scalars())
        missing = [name for name in REQUIRED_EXTENSIONS if name not in installed]
        if missing:
            commands = " ".join(f"CREATE EXTENSION {name};" for name in missing)
            raise RuntimeError(
                f"このDBに拡張 {', '.join(missing)} が入っていません。"
                f"スーパーユーザーで先に実行してください: {commands}")
        await conn.run_sync(declared_metadata().create_all)


# --- 区間粒度の材料 -----------------------------------------------------------

#: 材料ではないが、材料と同じ1回のクエリで求まるため一緒に受け取る列。
_EXTRA_MATERIAL_ARRAY_COLUMNS: dict[str, str] = {
    "distance_m": "re.distance_m",
    # 逆向きの方位は+180°ではない。両向きぶんを列で持つ（`road_edges`）。
    "bearing_deg": "CASE WHEN ids.forward THEN re.bearing_deg ELSE re.reverse_bearing_deg END",
    **dict(zip(("mid_lat", "mid_lon"), midpoint_sql("nf.geom", "nt.geom"), strict=True)),
    "start_elevation_m": "em.start_elevation_m",
    "end_elevation_m": "em.end_elevation_m",
    "elevation_gain_m": "em.elevation_gain_m",
    "elevation_loss_m": "em.elevation_loss_m",
    "steepest_gain_percent": "em.steepest_gain_percent",
    "steepest_loss_percent": "em.steepest_loss_percent",
}

#: 列の並びは渡した3つ組の位置で固定する。**road_edgesへLEFT JOINする**——行が無い区間で
#: 配列が短くなると、以降の列と静かにずれる。`em`は向きを解いた値で、材料の式は向きを知らずに済む。
_EDGE_MATERIAL_ARRAYS_FROM = f"""
FROM unnest(CAST(:way_ids AS bigint[]), CAST(:segment_indexes AS int[]),
            CAST(:forwards AS boolean[]))
     WITH ORDINALITY AS ids(osm_way_id, segment_index, forward, ord)
LEFT JOIN road_edges re
       ON re.osm_way_id = ids.osm_way_id AND re.segment_index = ids.segment_index
LEFT JOIN LATERAL {ways_lookup_sql('ids.osm_way_id')} w ON true
{material_from_clause([*material_value_sql().values(), *_EXTRA_MATERIAL_ARRAY_COLUMNS.values()],
                      'ids.osm_way_id', 'ids.segment_index', forward='ids.forward')}
LEFT JOIN LATERAL {nodes_lookup_sql('re.from_node_id')} nf ON true
LEFT JOIN LATERAL {nodes_lookup_sql('re.to_node_id')} nt ON true
"""

# 列の並びとSQLを1つの辞書から導く（別々に並べると、並びがずれても気付けない）。
_EDGE_MATERIAL_ARRAY_EXPRESSIONS = {**dict(sorted(material_value_sql().items())), **_EXTRA_MATERIAL_ARRAY_COLUMNS}
MATERIAL_ARRAY_COLUMN_ORDER: tuple[str, ...] = tuple(_EDGE_MATERIAL_ARRAY_EXPRESSIONS)

_EDGE_MATERIAL_ARRAYS_SQL = text(
    "SELECT "
    + ", ".join(
        f'array_agg(({expr}) ORDER BY ids.ord) AS "c_{name}"' for name, expr in _EDGE_MATERIAL_ARRAY_EXPRESSIONS.items()
    )
    + _EDGE_MATERIAL_ARRAYS_FROM
)


#: 区間ごとの断面の点の標高を、渡した並びの順に1区間1行で読む。値の無い点はDBの側でNaNにする（受け取ってから1点ずつ
#: 置き換えると、全区間の点をPythonで回す）。
_EDGE_ELEVATION_PROFILES_SQL = text("""
SELECT array_replace(ee.elevation_profile_m, NULL, 'NaN'::real) AS elevation_profile_m
FROM unnest(CAST(:way_ids AS bigint[]), CAST(:segment_indexes AS int[]))
     WITH ORDINALITY AS ids(osm_way_id, segment_index, ord)
LEFT JOIN edge_elevation ee ON ee.osm_way_id = ids.osm_way_id AND ee.segment_index = ids.segment_index
ORDER BY ids.ord
""")


# --- グラフの読み出し ---------------------------------------------------------
#
# 区間は向きを持たない1行で、**有向の枝は道路網全体の配列を作るとき**
# （`infrastructure/road_network_store.py`）に作る。道の通行方向（`way_directions.direction`）が逆向きの枝を
# 作ってよいかを決める。

#: 取込範囲全体の区間（向きを持たない1行）。どの道も通行方向の行を持つ（通行方向の段が数を比べて守る）ので、
#: どの区間も通行方向を持つ。並びは`domain/road_network.py`の行順の前提。端のそばの向きは、
#: 折れ線の向き（始点→終点）に進むときと逆に進むときの両方を持ち、端から`:bearing_distance_m`の道のりの点までで測る
#: （区間がそれより短ければ端から端を見る）。
_NEAR_START = "ST_LineInterpolatePoint(re.geom, LEAST(1.0, :bearing_distance_m / re.distance_m))"
_NEAR_END = "ST_LineInterpolatePoint(re.geom, GREATEST(0.0, 1.0 - :bearing_distance_m / re.distance_m))"
_NETWORK_EDGES_SQL = text(f"""
SELECT re.osm_way_id, re.segment_index, re.from_node_id, re.to_node_id,
       w.highway, wm.direction,
       ST_XMin(re.geom) AS min_lon, ST_YMin(re.geom) AS min_lat,
       ST_XMax(re.geom) AS max_lon, ST_YMax(re.geom) AS max_lat,
       {bearing_sql("ST_StartPoint(re.geom)", _NEAR_START)} AS start_bearing_deg,
       {bearing_sql(_NEAR_END, "ST_EndPoint(re.geom)")} AS end_bearing_deg,
       {bearing_sql("ST_EndPoint(re.geom)", _NEAR_END)} AS reverse_start_bearing_deg,
       {bearing_sql(_NEAR_START, "ST_StartPoint(re.geom)")} AS reverse_end_bearing_deg
FROM road_edges re
JOIN LATERAL {ways_lookup_sql("re.osm_way_id")} w ON true
{material_from_clause(["wm.direction"], "re.osm_way_id")}
ORDER BY re.osm_way_id, re.segment_index
""")


#: 道路網全体の配列を作る読み出しが読む較正値。値は作り直しに使った値（`get_recorded_tuning`）で、文へ引数で渡る。
NETWORK_TUNING = (TURN_BEARING_DISTANCE_ID,)

#: 区間の端点全件（`road_edges`の端点は`road_nodes`に行を持ち、`road_nodes`の全行が`node_turns`に行を持つ）。
#: 座標はノードの生データから読み、生データが無いノードは現れない。
_NETWORK_NODES_SQL = text(f"""
SELECT nm.osm_node_id, ST_X(n.geom) AS longitude, ST_Y(n.geom) AS latitude,
       nm.has_traffic_signals, nm.max_highway_rank, rn.branch_count
FROM node_turns nm
JOIN road_nodes rn ON rn.osm_node_id = nm.osm_node_id
JOIN LATERAL {nodes_lookup_sql("nm.osm_node_id")} n ON true
ORDER BY nm.osm_node_id
""")

#: 取込範囲全体の道路網（`infrastructure/road_network_store.py`）を作る読み出し。置き場の
#: 形の署名はここから導く——材料の式を変えると、作り直すべき置き場が別名になる。較正値は文に値で入れず引数で渡す：
#: 較正値は派生の世代に結ばれ（作り直すと世代が進む）、署名に値を入れると、値を変えてから作り直すまで読み手の
#: 開ける置き場が無くなる。
NETWORK_SQL_SOURCES = (
    _NETWORK_EDGES_SQL,
    _NETWORK_NODES_SQL,
    _EDGE_MATERIAL_ARRAYS_SQL,
    _EDGE_ELEVATION_PROFILES_SQL,
)

_EDGE_GEOMETRIES_SQL = text("""
SELECT re.osm_way_id, re.segment_index, re.from_node_id, re.to_node_id,
       re.distance_m, ST_AsBinary(re.geom) AS wkb
FROM unnest(CAST(:way_ids AS bigint[]), CAST(:segment_indexes AS int[]))
     AS ids(osm_way_id, segment_index)
JOIN road_edges re
  ON re.osm_way_id = ids.osm_way_id AND re.segment_index = ids.segment_index
""")


def _rows_to_directed_edges(rows, wanted: dict[tuple[int, int], list[bool]]) -> dict[str, LeanEdge]:
    """ジオメトリ付きの`LeanEdge`。逆向きは形状点列を逆順にする。

    `shapely.from_wkb`のバッチAPIで一括デコードする（GEOS呼び出しのループをPythonでは
    なくC側で回す）。
    """
    rows = list(rows)
    lines = shapely.from_wkb([bytes(row.wkb) for row in rows])
    edges: dict[str, LeanEdge] = {}
    for row, line in zip(rows, lines):
        points = [[lat, lon] for lon, lat in line.coords]
        for forward in wanted.get((row.osm_way_id, row.segment_index), ()):
            from_id, to_id = ((row.from_node_id, row.to_node_id) if forward
                              else (row.to_node_id, row.from_node_id))
            key = edge_key(row.osm_way_id, row.segment_index, forward)
            edges[key] = LeanEdge(
                edge_id=key, from_node_id=node_key(from_id), to_node_id=node_key(to_id),
                geometry=points if forward else list(reversed(points)),
                distance_m=row.distance_m, osm_way_id=row.osm_way_id,
                segment_index=row.segment_index, forward=forward,
            )
    return edges


def _float_array(values: list) -> np.ndarray:
    """NoneはNaNになる。"""
    return np.array(values, dtype=np.float64)


def _bbox_params(bbox: BoundingBox) -> dict[str, float]:
    return {
        "xmin": bbox.min_longitude, "ymin": bbox.min_latitude,
        "xmax": bbox.max_longitude, "ymax": bbox.max_latitude,
    }


def _tile_params(z: int, x: int, y: int, bbox: BoundingBox) -> dict[str, object]:
    return {"z": z, "x": x, "y": y, **_bbox_params(bbox)}


class RoadGraphRepository:
    """道路網と材料の読み出し。1つのAsyncSessionを使う。"""

    def __init__(self, session: AsyncSession):
        self._session = session

    # --- 世代・カバレッジ ----------------------------------------------------

    async def get_data_revisions(self) -> derived_data_meta.DataRevisions:
        """派生データと生データの世代。派生の世代は道路網全体の配列の置き場の名前に、
        両方が配信する地図タイルの世代に入る。"""
        return await derived_data_meta.get_revisions(self._session)

    async def get_accident_years(self) -> list[int]:
        """事故データの収録年。

        今の派生の表を作った事故の取込（`derived_data_meta.py: DerivedSourceRunRow`）の宣言（`rows.years`）を
        そのまま返す。最新の取込の宣言を読むと、取り込み直してから派生の作り直しが入れ替わるまでの間、
        古い数を新しい年数で割る。実データの発生年を数えると、事故が1件も無かった年が落ちる。
        年数は`accident_count_per_km_year`の分母に、年そのものは地図の説明文に使う。どちらもここが
        正本で、**表示側は年を自分で持たない**。
        """
        row = await self._session.execute(text(
            "SELECT r.profile->'source'->'rows'->'years' AS years"
            f" FROM {derived_data_meta.DerivedSourceRunRow.__tablename__} d"
            " JOIN source_runs r ON r.run_id = d.run_id WHERE d.source = :source"), {"source": Source.ACCIDENT})
        value = row.scalar()
        if not isinstance(value, list):
            return []
        return sorted(int(year) for year in value)

    async def get_accident_years_covered(self) -> int:
        """事故データの収録年数。`accident_count_per_km_year`の分母。"""
        return len(await self.get_accident_years())

    async def is_covered(self, bbox: BoundingBox) -> bool:
        """その範囲の生データを取り込んでいるか。判定は取込の宣言から導く。"""
        row = await self._session.execute(text(f"SELECT covered FROM ({COVERAGE_SQL}) c"), _bbox_params(bbox))
        return bool(row.scalar())

    async def get_ingested_area(self) -> BoundingBox | None:
        """取り込んだ範囲（`is_covered`が判定に使うのと同じ範囲）。道路をまだ取り込んでいなければNone。"""
        row = (await self._session.execute(text(INGESTED_BBOX_SQL))).mappings().one_or_none()
        if row is None:
            return None
        return BoundingBox(
            min_latitude=row["min_lat"], min_longitude=row["min_lon"],
            max_latitude=row["max_lat"], max_longitude=row["max_lon"],
        )

    # --- グラフ --------------------------------------------------------------

    async def get_network_tuning(self) -> dict[str, float]:
        """道路網全体の配列を作る読み出しが読む較正値（`NETWORK_TUNING`）の、作り直しに使った値。"""
        return await self.get_recorded_tuning(NETWORK_TUNING)

    async def get_recorded_tuning(self, param_ids: Sequence[str]) -> dict[str, float]:
        """`param_ids`の較正値の、作り直しに使った値（id → 値）。記録に無ければ`KeyError`。"""
        recorded = dict((await self._session.execute(
            select(derived_data_meta.DerivedTuningRow.param_id, derived_data_meta.DerivedTuningRow.value)
            .where(derived_data_meta.DerivedTuningRow.param_id.in_(param_ids))
        )).all())
        return {param_id: recorded[param_id] for param_id in param_ids}

    def stream_network_edges(self, chunk_size: int, tuning: Mapping[str, float]) -> AsyncIterator[Sequence[Row]]:
        """取込範囲全体の区間を`chunk_size`行ずつ流す（`_NETWORK_EDGES_SQL`の並び）。`tuning`は`get_network_tuning`の値。"""
        return self._stream(_NETWORK_EDGES_SQL.bindparams(bearing_distance_m=tuning[TURN_BEARING_DISTANCE_ID]), chunk_size)

    def stream_network_nodes(self, chunk_size: int) -> AsyncIterator[Sequence[Row]]:
        """区間の端点になりうるノード全件を`chunk_size`行ずつ流す（`osm_node_id`の昇順）。"""
        return self._stream(_NETWORK_NODES_SQL, chunk_size)

    async def _stream(self, statement: TextClause, chunk_size: int) -> AsyncIterator[Sequence[Row]]:
        result = await self._session.stream(statement)
        async for chunk in result.partitions(chunk_size):
            yield chunk

    async def get_edges_with_geometry(self, edges: list[LeanEdge]) -> dict[str, LeanEdge]:
        """指定した枝ぶんだけ、実ジオメトリ込みの`LeanEdge`を取得する。

        探索用グラフはジオメトリを持たない。確定した経路（1候補あたり数十〜数百区間）
        だけへ絞って取り直す。
        """
        if not edges:
            return {}
        # 両向きの枝を頼まれても区間ごとに1行だけ引く（形は向きに依らず、逆向きは逆順にすれば足りる）。
        # 向きの数だけ引くと、行も問い合わせの束（`ID_CHUNK_SIZE`）の数も増える。
        wanted: dict[tuple[int, int], list[bool]] = {}
        for edge in edges:
            wanted.setdefault((edge.osm_way_id, edge.segment_index), []).append(edge.forward)
        keys = sorted(wanted)
        result: dict[str, LeanEdge] = {}
        for chunk in batched(keys, ID_CHUNK_SIZE):
            rows = (await self._session.execute(_EDGE_GEOMETRIES_SQL, {
                "way_ids": [k[0] for k in chunk],
                "segment_indexes": [k[1] for k in chunk],
            })).all()
            result.update(await asyncio.to_thread(_rows_to_directed_edges, rows, wanted))
        return result

    # --- 材料 ----------------------------------------------------------------

    async def get_edge_material_arrays(
        self, way_ids: list[int], segment_indexes: list[int], forwards: list[bool], accident_years_covered: int
    ) -> EdgeMaterialArrays:
        """有向の区間（`(osm_way_id, segment_index, forward)`を位置で揃えた3本の列）の材料を、
        **DB側で導出し、数値の行列と分類の列として**受け取る。

        区間数に比例するPythonの仕事を持たない。**すべての列が同じ並びを持つ**必要がある
        （1つでも違うと値が列の間で静かにずれ、エラーは出ない）。並びは渡した区間の位置
        （`WITH ORDINALITY`）で固定する。
        """
        numeric_ids, categorical_ids = material_array_columns()
        raw: dict[str, list] = {name: [] for name in MATERIAL_ARRAY_COLUMN_ORDER}
        n = len(way_ids)
        for start in range(0, n, ID_CHUNK_SIZE):
            stop = start + ID_CHUNK_SIZE
            row = (await self._session.execute(_EDGE_MATERIAL_ARRAYS_SQL, {
                "way_ids": way_ids[start:stop], "segment_indexes": segment_indexes[start:stop],
                "forwards": forwards[start:stop], "accident_years": accident_years_covered,
            })).one()
            for name in raw:
                raw[name].extend(getattr(row, f"c_{name}") or [])

        numeric_values = np.empty((n, len(numeric_ids)), dtype=np.float64)
        for i, material_id in enumerate(numeric_ids):
            numeric_values[:, i] = _float_array(raw[material_id])

        return EdgeMaterialArrays(
            numeric_ids=numeric_ids, numeric_values=numeric_values,
            categorical_ids=categorical_ids,
            categorical_columns=tuple(CategoricalColumn.encode(raw[material_id]) for material_id in categorical_ids),
            **{name: _float_array(raw[name]) for name in _EXTRA_MATERIAL_ARRAY_COLUMNS},
        )

    async def get_edge_elevation_profiles(self, way_ids: list[int], segment_indexes: list[int]) -> list[np.ndarray]:
        """区間（位置で揃えた2本の列）ごとの、順方向に並べた断面の点の標高（m、float32、値の無い点はNaN）。標高の行が無い
        区間は空の配列。区間ごとに点の数が違い、材料の列のように配列へまとめられないので、区間ごとの行で読む。"""
        profiles: list[np.ndarray] = []
        for start in range(0, len(way_ids), ID_CHUNK_SIZE):
            stop = start + ID_CHUNK_SIZE
            rows = (await self._session.execute(_EDGE_ELEVATION_PROFILES_SQL, {
                "way_ids": way_ids[start:stop], "segment_indexes": segment_indexes[start:stop],
            })).all()
            profiles.extend(np.asarray(row.elevation_profile_m or (), dtype=np.float32) for row in rows)
        return profiles

    async def get_way_tags_by_osm_way_id(
        self, osm_way_id: int
    ) -> tuple[str, dict[str, str]] | None:
        """osm_way_id完全一致で(highway, tags)を返す。道は種別を必ず持つ（`source_features_way_has_kind`）。

        空間マッチ（半径内最近傍）は、交差点付近など複数の道路が近接する場所で、実際に
        クリックされたフィーチャーとは別の道路を拾いうる。フィーチャーが指す行そのものを
        引き直すことで、この不整合を構造的に防ぐ。
        """
        row = (await self._session.execute(text(f"""
            SELECT w.highway, w.tags
            FROM {ways_lookup_sql(":osm_way_id")} w
        """), {"osm_way_id": str(osm_way_id)})).first()
        if row is None:
            return None
        return (row.highway, row.tags)

    async def roads_at(self, lon: float, lat: float, z: int, radius_m: float, limit: int) -> list[RoadAt]:
        """押した所`(lon, lat)`から`radius_m`以内の道のフィーチャーを、近い順に`limit`本（`road_tile_sql.py: ROADS_AT_SQL`）。
        フィーチャーの単位とプロパティは、ズーム`z`の路面タイルと同じ。"""
        reach = degrees_covering_m(radius_m)
        rows = await self._session.execute(ROADS_AT_SQL, {
            "lon": lon, "lat": lat, "z": z, "radius_m": radius_m, "limit": limit,
            "xmin": lon - reach, "ymin": lat - reach, "xmax": lon + reach, "ymax": lat + reach,
        })
        return [
            RoadAt(
                properties={column: value for column, value in row._mapping.items()
                            if column != "shape" and value is not None},
                shape=[(lon_, lat_) for lon_, lat_ in shapely.from_geojson(row.shape).coords],
            )
            for row in rows
        ]

    async def get_road_surface_tile_mvt(
        self, z: int, x: int, y: int, bbox: BoundingBox, layer_values: Mapping[str, Mapping[str, str]]
    ) -> bytes | None:
        """路面レイヤーのMVTタイル1枚。`layer_values`はフィーチャーの鍵→地図の線の層のid→値（値の無い道は載せない）。契約は
        `get_tile_mvt`と同じ。"""
        return await self._tile_mvt(ROAD_SURFACE_TILE_MVT_SQL, ROAD_SURFACE_LAYER_NAME, z, x, y, bbox,
                                    {"layer_values": json.dumps(layer_values, ensure_ascii=False)})

    async def get_tile_mvt(
        self, sql: TextClause, layer_name: str, z: int, x: int, y: int, bbox: BoundingBox
    ) -> bytes | None:
        """`(covered, tile)`の1行を返すMVT生成SQLを流し、タイル1枚をPostGIS側（ST_AsMVT）で丸ごと生成して返す。

        取込範囲外はNone（呼び出し側が空タイルへのフォールバックを判断する）。範囲内で
        対象が1つも無い場合は空バイト列（有効な空MVT、「無いことを確認済み」の
        正常応答でNoneとは区別される）。
        """
        return await self._tile_mvt(sql, layer_name, z, x, y, bbox, {})

    async def _tile_mvt(
        self, sql: TextClause, layer_name: str, z: int, x: int, y: int, bbox: BoundingBox, params: Mapping[str, object]
    ) -> bytes | None:
        result = await self._session.execute(sql, {
            **_tile_params(z, x, y, bbox),
            "layer_name": layer_name, "extent": TILE_EXTENT, **params,
        })
        covered, tile = result.one()
        if not covered:
            return None
        # 範囲内で対象0行のときST_AsMVT（集約関数）はNULLを返す。長さ0のバイト列は
        # 「featureが1つも無い有効なMVT」としてMapLibreがそのまま受理する。
        return bytes(tile) if tile is not None else b""

    async def get_feature_materials_in_tile(
        self, z: int, x: int, y: int, bbox: BoundingBox, accident_years_covered: int
    ) -> FeatureMaterials | None:
        """指定タイルのフィーチャーごとの全材料（探索と同じ値式、`road_tile_sql.py: FEATURE_MATERIALS_IN_TILE_SQL`）。
        鍵はタイルが焼いた`feature_key`と同じもの。取込範囲外はNone、範囲内0件は0行。"""
        row = (await self._session.execute(FEATURE_MATERIALS_IN_TILE_SQL, {
            **_tile_params(z, x, y, bbox), "accident_years": accident_years_covered,
        })).one()
        if not row.covered:
            return None
        numeric_ids, categorical_ids = material_array_columns()
        columns: dict[str, MaterialColumn] = {
            **{material_id: _float_array(getattr(row, f"c_{material_id}") or []) for material_id in numeric_ids},
            **{material_id: CategoricalColumn.encode(getattr(row, f"c_{material_id}") or [])
               for material_id in categorical_ids},
        }
        return FeatureMaterials(feature_keys=tuple(row.feature_keys or ()), columns=columns)
