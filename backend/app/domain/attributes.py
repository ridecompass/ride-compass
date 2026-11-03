from collections.abc import Iterable, Mapping
from dataclasses import dataclass, fields
from typing import Any

import numpy as np

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
    # 進む向きに見た、断面の刻みの間で一番急な登りと下りの勾配（%、どちらも0以上）。値が無ければNone。
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


# 舗装された公道としてありうる平均勾配の上限（%）。世界でも最急の公道が35%前後のため、
# これを超える値は道の起伏ではなくDEMの読み違い（両端が路面でない地物を指した等）である。
# 超えた区間は値を持たせず「データなし」にする——0次ハードフィルタは値の無い区間を
# 除外しない（`domain/hard_filters.py`）ので、誤った値で黙って経路から外すより安全側になる。
MAX_PLAUSIBLE_AVERAGE_GRADE_PERCENT = 40.0
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

    def equals(self, value: object) -> np.ndarray:
        """区間ごとに、値が`value`と一致するか。値なしはどの`value`にも一致しない。"""
        matching = [code for code, known in enumerate(self.vocab) if known is not None and known == value]
        return np.isin(self.codes, matching)


# 材料1列の配列の形。分類の材料は`CategoricalColumn`、それ以外は数値・真偽のnumpy配列。
MaterialColumn = np.ndarray | CategoricalColumn


@dataclass(frozen=True, slots=True)
class EdgeMaterialArrays:
    """区間の材料を、**数値（真偽を含む）は1つの2次元配列**で保持する表現。

    値はDBが導出したものをそのまま受ける（`MaterialSpec.value_sql`）。
    区間ごとのPythonオブジェクトを経由しない。

    材料ごとに別々の配列を持たず、`StaticEdgeScoreMatrix`と同じ「値の行列＋idの並び」の形に
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
    """点数の表を組む入力（`domain/evaluation.py: build_static_edge_score_matrix`）。切り出した区間の材料id→列と、区間の値。

    材料の列は読まれたときに切り出し、数値の列はそれぞれ連続した配列で返す（`domain/road_network.py: material_arrays_of`）。
    """

    columns: Mapping[str, MaterialColumn]
    distance_m: np.ndarray  # dtype=float64
    bearing_deg: np.ndarray  # dtype=float64, NaN=方位が決まらない
    mid_lat: np.ndarray  # dtype=float64
    mid_lon: np.ndarray  # dtype=float64

    def __len__(self) -> int:
        return len(self.distance_m)


#: `EdgeMaterialArrays`のうち、区間の行をそのまま並べる配列の欄。区間の束を継ぐ・行を切り出す側はこれを回し、
#: 欄の名前を並べ直さない。分類の材料は列ごとに語彙が違うので含めない。
EDGE_ROW_ARRAY_FIELDS: tuple[str, ...] = tuple(
    field.name for field in fields(EdgeMaterialArrays) if field.type is np.ndarray
)


def elevation_values_sql(vertices: str, step_m: str) -> str:
    """区間の点列（標高の断面）から、標高と勾配の値を出すSQL。

    `vertices`は`(osm_way_id, segment_index, ord, along_m, elev, on_structure)`を返す関係。`along_m`は区間の始まりから
    道に沿って測った点の位置（m）で、距離はすべてこの差で測る——点どうしを直線で測ると、曲がった区間で道のりより短く出て
    勾配が大きく出る。区間の長さは最後の点の位置。`elev`がNULLの点は評価から外す。**外した後に隣り合う2点でも、元の点列では
    間に欠損を挟んでいることがある**——そのまま隣接扱いすると、欠損区間の起伏が均された差として
    混入する。獲得/消失と一番急な勾配（欠損を挟むと信頼できない）は元の点列でも真に隣接していたペアだけから出す。

    一番急な勾配（`steepest_gain_percent`・`steepest_loss_percent`）は、隣り合う2点の間の勾配のうち、登りと下りの
    それぞれの最大の大きさ（どちらも0以上）。点の間隔が勾配をならす幅になる。**区間が`step_m`（断面の刻み。SQLの式で渡す）
    より短ければ、両端の差を刻みの幅で割る**——数十mの道の跳ね上がりを、その短さのまま急な坂にしない。
    公道としてありえない勾配の間は、標高データの読み違いとして最大に数えない。数えられる間が無い区間は値を持たない。

    `on_structure`（橋・高架・トンネル）は**値のある両端の2点だけ**を使い、その2点を隣り合う組として数える。配信元のDEMは
    地表面の値で構造物の高さを反映しないため（https://maps.gsi.go.jp/development/hyokochi.html に明記）、
    中間の点は桁や坑道ではなく下の地形を指す。谷を渡る平らな橋で、谷底の起伏がそのまま
    獲得標高へ積まれてしまう。橋台・坑口は道が地面と接する位置なので、両端の標高は使える。

    値が出せない区間（有効な標高が2点未満）は返らない。値と一緒に、値が依った`on_structure`と、断面の点の標高を順に並べた
    `elevation_profile_m`（値の無い点はNULL。橋とトンネルは両端の2点）も返す——要約の列は、この並びと同じ点から出る。
    """
    return f"""
WITH v AS ({vertices}),
measured AS (
    SELECT *, max(along_m) OVER (PARTITION BY osm_way_id, segment_index) AS length_m FROM v),
known AS (
    SELECT *, min(ord) OVER s AS first_ord, max(ord) OVER s AS last_ord
    FROM measured WHERE elev IS NOT NULL WINDOW s AS (PARTITION BY osm_way_id, segment_index)),
profile AS (SELECT * FROM known WHERE NOT on_structure OR ord IN (first_ord, last_ord)),
points AS (
    SELECT osm_way_id, segment_index,
           array_agg(elev::real ORDER BY ord) FILTER (WHERE NOT on_structure OR ord IN (0, max_ord)) AS elevation_profile_m
    FROM (SELECT *, max(ord) OVER (PARTITION BY osm_way_id, segment_index) AS max_ord FROM v) a
    GROUP BY osm_way_id, segment_index),
ends AS (
    SELECT osm_way_id, segment_index, bool_or(on_structure) AS on_structure,
           count(*) AS n, max(along_m) - min(along_m) AS total_d,
           (array_agg(elev ORDER BY ord))[1] AS start_e,
           (array_agg(elev ORDER BY ord DESC))[1] AS end_e
    FROM profile GROUP BY osm_way_id, segment_index),
pairs AS (
    SELECT osm_way_id, segment_index, length_m,
           elev - lag(elev) OVER w AS diff,
           on_structure OR ord - lag(ord) OVER w = 1 AS adjacent,
           along_m - lag(along_m) OVER w AS d
    FROM profile WINDOW w AS (PARTITION BY osm_way_id, segment_index ORDER BY ord)),
graded AS (
    SELECT osm_way_id, segment_index, diff, adjacent,
           CASE WHEN adjacent AND d > 0
                THEN diff / (CASE WHEN length_m < {step_m} THEN {step_m} ELSE d END) * 100 END AS g
    FROM pairs WHERE diff IS NOT NULL),
agg AS (
    SELECT osm_way_id, segment_index,
           coalesce(sum(greatest(diff, 0))  FILTER (WHERE adjacent), 0) AS gain,
           coalesce(sum(greatest(-diff, 0)) FILTER (WHERE adjacent), 0) AS loss,
           max(greatest(g, 0))  FILTER (WHERE abs(g) <= {MAX_PLAUSIBLE_AVERAGE_GRADE_PERCENT}) AS steepest_up,
           max(greatest(-g, 0)) FILTER (WHERE abs(g) <= {MAX_PLAUSIBLE_AVERAGE_GRADE_PERCENT}) AS steepest_down
    FROM graded GROUP BY osm_way_id, segment_index),
raw AS (
    SELECT e.osm_way_id, e.segment_index, e.on_structure, e.start_e, e.end_e,
           a.gain, a.loss, a.steepest_up, a.steepest_down,
           CASE WHEN abs(s.g) <= {MAX_PLAUSIBLE_AVERAGE_GRADE_PERCENT} THEN s.g END AS avg_g
    FROM ends e JOIN agg a USING (osm_way_id, segment_index),
         LATERAL (SELECT CASE WHEN e.total_d > 0 THEN (e.end_e - e.start_e) / e.total_d * 100 END AS g) s
    WHERE e.n >= 2)
SELECT osm_way_id, segment_index,
       round(start_e::numeric, 1) AS start_elevation_m,
       round(end_e::numeric, 1)   AS end_elevation_m,
       round(gain::numeric, 1)    AS elevation_gain_m,
       round(loss::numeric, 1)    AS elevation_loss_m,
       round(avg_g::numeric, {AVERAGE_GRADE_DECIMALS}) AS average_grade,
       round(steepest_up::numeric, {AVERAGE_GRADE_DECIMALS})   AS steepest_gain_percent,
       round(steepest_down::numeric, {AVERAGE_GRADE_DECIMALS}) AS steepest_loss_percent,
       on_structure, p.elevation_profile_m
FROM raw JOIN points p USING (osm_way_id, segment_index)
"""
