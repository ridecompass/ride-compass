from collections.abc import Iterable, Mapping
from dataclasses import dataclass, fields
from typing import Any

import numpy as np

from app.domain.elevation_profile import MAX_PLAUSIBLE_GRADE_PERCENT, ElevationProfiles
from app.domain.strict_model import StrictModel


class ElevationAttribute(StrictModel):
    """Edgeへ紐付ける標高属性。Edge本体（domain/graph.py）とは独立して保持する。

    average_gradeは符号付き（登り=正、下り=負）で、値が取れなかった区間はNone。
    獲得・喪失標高は揃って入る（区間の標高の表`edge_elevation`は4列とも空を許さない）。
    """

    edge_id: str
    # 進む向きに見た始まりと終わりの標高（m）。
    start_elevation_m: float
    end_elevation_m: float
    elevation_gain_m: float
    elevation_loss_m: float
    average_grade: float | None
    # 進む向きに見た、断面の点の間で一番急な登りと下りの勾配（%、どちらも0以上）。値が無ければNone。
    steepest_gain_percent: float | None
    steepest_loss_percent: float | None

    def reversed_as(self, reverse_edge_id: str) -> "ElevationAttribute":
        """同じ地形を逆方向に走った区間（`reverse_edge_id`）の値。標高は進行方向に依存しないため
        代数的に厳密に決まる: 始まり↔終わりの標高・獲得標高↔喪失標高・一番急な登り↔下りの入れ替え、平均勾配の符号反転。
        """
        return ElevationAttribute(
            edge_id=reverse_edge_id,
            start_elevation_m=self.end_elevation_m,
            end_elevation_m=self.start_elevation_m,
            elevation_gain_m=self.elevation_loss_m,
            elevation_loss_m=self.elevation_gain_m,
            average_grade=-self.average_grade if self.average_grade is not None else None,
            steepest_gain_percent=self.steepest_loss_percent,
            steepest_loss_percent=self.steepest_gain_percent,
        )


#: 平均勾配（%）を保存・配信する桁。
AVERAGE_GRADE_DECIMALS = 2


@dataclass(frozen=True, slots=True)
class CategoricalColumn:
    """分類の材料1列を、区間ごとの語彙への番号（`codes`）と語彙（`vocab`）で持つ。番号0は値なしで、
    `vocab[0]`は必ずNone。

    区間ごとに値の文字列を持たない。値から数を引く（軸の対応表・転がり抵抗）のは語彙の大きさの表を
    作って番号で引くだけになり、区間ごとにPythonの辞書を引かずに済む。
    """

    codes: np.ndarray  # 整数（道路網の置き場はint16）
    vocab: tuple[str | None, ...]

    @classmethod
    def empty(cls, n: int) -> "CategoricalColumn":
        """値の無い区間`n`本ぶんの列（全部が番号0）。"""
        return cls(np.zeros(n, dtype=np.int16), (None,))

    @classmethod
    def encode(cls, values: Iterable[str | None]) -> "CategoricalColumn":
        """値の並び（値なしはNone）を、現れた順に番号を振った列にする。"""
        code_of: dict[str | None, int] = {None: 0}
        codes = np.fromiter((code_of.setdefault(value, len(code_of)) for value in values), dtype=np.int16)
        return cls(codes, tuple(code_of))

    def __len__(self) -> int:
        return len(self.codes)

    def take(self, rows: np.ndarray) -> "CategoricalColumn":
        return CategoricalColumn(self.codes[rows], self.vocab)

    def value_at(self, row: int) -> str | None:
        return self.vocab[int(self.codes[row])]

    def lookup(self, table: Mapping[Any, float]) -> np.ndarray:
        """区間ごとに、値を`table`で引いた数（float64）。値なしと`table`に無い値はNaN。"""
        per_code = np.array([np.nan if value is None else table.get(value, np.nan) for value in self.vocab])
        return per_code[self.codes]


# 材料1列の配列の形。分類の材料は`CategoricalColumn`、それ以外は数値・真偽のnumpy配列。
MaterialColumn = np.ndarray | CategoricalColumn


@dataclass(frozen=True, slots=True)
class EdgeMaterialArrays:
    """区間の材料を、**数値（真偽を含む）は1つの2次元配列**で保持する表現。

    値はDBが導出したものをそのまま受ける（`MaterialSpec.value_sql`）。
    区間ごとのPythonオブジェクトを経由しない。

    材料ごとに別々の配列を持たず、`domain/search_materials.py: SearchMaterials`と同じ「値の行列＋idの並び」の形に
    する。材料が増えてもフィールドは増えず、列の追加は`*_ids`が1つ伸びるだけになる。
    数値と分類の2つに分かれるのは、カテゴリを数値の行列へ混ぜられないため（真偽の材料は数値の行列に
    1.0/0.0/NaNで載る。分け方は`material_catalog.material_array_columns`が決める）。
    カテゴリは列ごとに語彙が違うため、行列ではなく列ごとの`CategoricalColumn`で持つ。

    標高の列は**材料ではない表示用の値**で、経路が確定したあとの区間について
    `domain/road_network.py: elevation_attribute`が`ElevationAttribute`を組み立てる。勾配そのものは材料
    `gradient_percent`にあるため、ここでは重複して持たない。
    """

    numeric_ids: tuple[str, ...]
    numeric_values: np.ndarray  # shape=(n, len(numeric_ids)), float64, NaN=欠損
    categorical_ids: tuple[str, ...]
    categorical_columns: tuple[CategoricalColumn, ...]  # categorical_idsと同じ並び
    # 区間そのものの値。グラフのオブジェクトから組み直さず、材料と同じクエリで受ける。
    distance_m: np.ndarray  # dtype=float64
    bearing_deg: np.ndarray  # dtype=float64, NaN=方位が決まらない
    mid_lat: np.ndarray  # dtype=float64
    mid_lon: np.ndarray  # dtype=float64
    start_elevation_m: np.ndarray  # dtype=float64, NaN=標高が無い（獲得・損失も無い）
    end_elevation_m: np.ndarray  # dtype=float64, NaN=標高が無い
    elevation_gain_m: np.ndarray  # dtype=float64, NaN=欠損
    elevation_loss_m: np.ndarray
    steepest_gain_percent: np.ndarray  # dtype=float64, NaN=欠損
    steepest_loss_percent: np.ndarray

    def __len__(self) -> int:
        return len(self.distance_m)


@dataclass(frozen=True)
class EdgeMaterialColumns:
    """探索の材料の表を組む入力（`domain/search_materials.py: build_search_materials`）。切り出した区間の材料id→列と、区間の値。

    材料の列は読まれたときに切り出し、数値の列はそれぞれ連続した配列で返す（`domain/road_network.py: material_arrays_of`）。
    """

    columns: Mapping[str, MaterialColumn]
    distance_m: np.ndarray  # dtype=float64
    bearing_deg: np.ndarray  # dtype=float64, NaN=方位が決まらない
    mid_lat: np.ndarray  # dtype=float64
    mid_lon: np.ndarray  # dtype=float64
    # 区間の断面の点（所要時間が読む）。
    elevation_profiles: ElevationProfiles

    def __len__(self) -> int:
        return len(self.distance_m)


#: `EdgeMaterialArrays`のうち、区間の行をそのまま並べる配列の欄。区間の束を継ぐ・行を切り出す側はこれを回し、
#: 欄の名前を並べ直さない。分類の材料は列ごとに語彙が違うので含めない。
EDGE_ROW_ARRAY_FIELDS: tuple[str, ...] = tuple(
    field.name for field in fields(EdgeMaterialArrays) if field.type is np.ndarray
)


#: 一番急な勾配を測る最短の長さ（m）。1つ前の点の間がこれ以下なら、その点で測らない。数える間の途切れない続きの長さが
#: これより短ければ、その続きの両端では測らない。短い間ほど標高データの揺れが勾配を大きく揺らす（GraphHopper の
#: https://github.com/graphhopper/graphhopper/blob/master/core/src/main/java/com/graphhopper/routing/util/SlopeCalculator.java
#: の`MIN_LENGTH`と同じ値と理由）。獲得標高・平均勾配と所要時間は、短い間も数える。
STEEPEST_MIN_INTERVAL_M = 2.0


def elevation_values_sql(vertices: str, tolerance_m: str) -> str:
    """区間に沿って拾った点（標高の断面）を揺れの閾値で間引き、残した点から標高と勾配の値を出すSQL。

    `vertices`は`(osm_way_id, segment_index, ord, along_m, elev)`を返す関係。`along_m`は区間の始まりから
    道に沿って測った点の位置（m）で、距離はすべてこの差で測る——点どうしを直線で測ると、曲がった区間で道のりより短く出て
    勾配が大きく出る。区間の長さは最後の点の位置。

    **間引きは、断面（横が道のり、縦が標高）に Douglas-Peucker をかける**（PostGIS の`ST_Simplify`。閾値`tolerance_m`はSQLの式で
    渡す）。閾値以下の揺れを消す。残る点の間の勾配は元の点の間の一番急な勾配を越えない（GraphHopper の ramer のならしと、そのあとの
    間引きと同じ）が、高さが閾値の数倍に満たない短い段は、前後の点と一緒になだらかに残ることがある。値の無い点をまたいで間引かない
    ——値のある点の続きごとに間引き、値の無い点は残す。残す点は、点の順（`ord`）を M の値に載せて取り戻す。

    **要約の列は、どれも残した点の隣り合う2点の間（点の間）のうち、勾配として数える間だけから出す**。数えるかは
    所要時間が点の間を読むときと同じ判定（`domain/elevation_profile.py: interval_grade`）で、両端に値があり、長さが0でなく、
    道のりで割った勾配が公道としてありうる上限以下の間だけを数える。値の無い点をまたいだ2点を隣どうしとして
    均さない——欠けた所の起伏が均された差として混ざる。獲得/喪失は数える間の上りと下りの和、平均勾配（`average_grade`）は
    （獲得−喪失）÷数える間の長さの和。数える間が無い区間は、平均勾配と一番急な勾配を持たず、獲得/喪失は0になる。

    一番急な勾配（`steepest_gain_percent`・`steepest_loss_percent`）は、GraphHopper の`SlopeCalculator`の max_slope の式で測る:
    3点目からの点ごとに、1つ前の2点の標高の平均から今の点までの勾配（長さは今の間と前の間の半分の和）を、前の間が
    `STEEPEST_MIN_INTERVAL_M`より長いときだけ取り、区間の両端の勾配も候補にする。隣り合う2点だけで測ると、
    短い間の揺れがそのまま一番急になる。この勾配は今の間と前の間の勾配を重みづけて平均したものなので、2つの間がどちらも
    数える間のときだけ取る。数えない間で途切れた区間は、途切れない続きごとを GraphHopper の1区間として測る（欠けた所を
    またいで均さない。欠けの無い区間では式のとおり）。GraphHopper は絶対値の一番大きい1つを持つが、ここでは登りと下りを分けて、
    それぞれの最大の大きさ（どちらも0以上）を持つ。長さが`STEEPEST_MIN_INTERVAL_M`以上の続きが無い区間は、平均勾配を持っても
    一番急な勾配を持たない。

    値のある点が2つ未満の区間は返らない。値と一緒に、残した点の標高と位置を順に並べた`elevation_profile_m`（値の無い点はNULL）と
    `elevation_profile_along_m`も返す——要約の列は、この並びの点の間から出る。
    """
    return f"""
-- 標高と位置は残す断面の点と同じ精度（real）に落としてから比べる。所要時間はその点を読むので、上限ちょうどの間で数えるかが分かれない。
WITH v AS (
    SELECT osm_way_id, segment_index, ord, along_m::real::float8 AS along_m, elev::real::float8 AS elev FROM ({vertices}) s),
-- 値の無い点で区切った、値のある点の続きの番号（値の無い点は次の続きの頭に入る）と、続きの中の値のある点の数。
runs AS (
    SELECT *, count(elev) OVER (PARTITION BY osm_way_id, segment_index, run) AS run_known
    FROM (SELECT *, count(*) FILTER (WHERE elev IS NULL) OVER (PARTITION BY osm_way_id, segment_index ORDER BY ord) AS run
          FROM v) n),
simplified AS (
    SELECT osm_way_id, segment_index, ST_M(d.geom)::int AS ord
    FROM (SELECT osm_way_id, segment_index,
                 ST_Simplify(ST_MakeLine(ST_MakePointM(along_m, elev, ord) ORDER BY ord), {tolerance_m}) AS line
          FROM runs WHERE elev IS NOT NULL AND run_known >= 3 GROUP BY osm_way_id, segment_index, run) l
    CROSS JOIN LATERAL ST_DumpPoints(l.line) d),
kept AS (
    SELECT r.osm_way_id, r.segment_index, r.ord, r.along_m, r.elev
    FROM runs r LEFT JOIN simplified k
      ON k.osm_way_id = r.osm_way_id AND k.segment_index = r.segment_index AND k.ord = r.ord
    WHERE r.elev IS NULL OR r.run_known < 3 OR k.ord IS NOT NULL),
pairs AS (
    SELECT *, elev - lag(elev) OVER w AS diff,
           along_m - lag(along_m) OVER w AS d
    FROM kept WINDOW w AS (PARTITION BY osm_way_id, segment_index ORDER BY ord)),
counted AS (
    SELECT *, CASE WHEN d > 0 AND abs(diff) * 100 <= {MAX_PLAUSIBLE_GRADE_PERCENT} * d THEN diff / d * 100 END AS g
    FROM pairs),
-- 一番急な勾配の候補（GraphHopper の max_slope）。数える間の途切れない続き（`span`）ごとに、1つ前の2点の標高の平均から今の点までの
-- 勾配（今の間と前の間がどちらも数える間で、前の間が最短の長さより長いとき）と、続きの両端の勾配（続きの長さが最短の長さ以上のとき）。
slopes AS (
    SELECT *, CASE WHEN g IS NOT NULL AND lag(g) OVER w IS NOT NULL AND lag(d) OVER w > {STEEPEST_MIN_INTERVAL_M}
                   THEN (diff + lag(diff) OVER w / 2) / (d + lag(d) OVER w / 2) * 100 END AS s,
              count(*) FILTER (WHERE g IS NULL) OVER w AS span
    FROM counted WINDOW w AS (PARTITION BY osm_way_id, segment_index ORDER BY ord)),
candidates AS (
    SELECT osm_way_id, segment_index, s AS slope FROM slopes WHERE s IS NOT NULL
    UNION ALL
    SELECT osm_way_id, segment_index, sum(diff) / sum(d) * 100
    FROM slopes WHERE g IS NOT NULL GROUP BY osm_way_id, segment_index, span HAVING sum(d) >= {STEEPEST_MIN_INTERVAL_M}),
steepest AS (
    SELECT osm_way_id, segment_index, max(greatest(slope, 0)) AS up, max(greatest(-slope, 0)) AS down
    FROM candidates GROUP BY osm_way_id, segment_index),
raw AS (
    SELECT osm_way_id, segment_index,
           array_agg(elev::real ORDER BY ord) AS elevation_profile_m,
           array_agg(along_m::real ORDER BY ord) AS elevation_profile_along_m,
           array_agg(elev ORDER BY ord) FILTER (WHERE elev IS NOT NULL) AS known,
           coalesce(sum(greatest(diff, 0)) FILTER (WHERE g IS NOT NULL), 0) AS gain,
           coalesce(sum(greatest(-diff, 0)) FILTER (WHERE g IS NOT NULL), 0) AS loss,
           sum(d) FILTER (WHERE g IS NOT NULL) AS counted_m
    FROM counted GROUP BY osm_way_id, segment_index)
SELECT osm_way_id, segment_index,
       round(known[1]::numeric, 1) AS start_elevation_m,
       round(known[cardinality(known)]::numeric, 1) AS end_elevation_m,
       round(gain::numeric, 1)    AS elevation_gain_m,
       round(loss::numeric, 1)    AS elevation_loss_m,
       round(((gain - loss) / counted_m * 100)::numeric, {AVERAGE_GRADE_DECIMALS}) AS average_grade,
       round(t.up::numeric, {AVERAGE_GRADE_DECIMALS})   AS steepest_gain_percent,
       round(t.down::numeric, {AVERAGE_GRADE_DECIMALS}) AS steepest_loss_percent,
       elevation_profile_m, elevation_profile_along_m
FROM raw LEFT JOIN steepest t USING (osm_way_id, segment_index) WHERE cardinality(known) >= 2
"""
