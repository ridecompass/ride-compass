from collections.abc import Iterable, Mapping
from dataclasses import dataclass, fields
from typing import Any

import numpy as np

from app.domain.elevation_profile import ProfileSpans
from app.domain.search_graph import EdgeValues
from app.domain.strict_model import StrictModel
from app.domain.wind_height import WindHeights


class ElevationAttribute(StrictModel):
    """Edgeへ紐付ける標高属性。Edge本体（domain/graph.py）とは独立して保持する。

    average_gradeは符号付き（登り=正、下り=負）で、値が取れなかった区間はNone。
    獲得・喪失標高は揃って入る（どれも断面から出す。`domain/elevation_profile.py: profile_summaries`）。
    """

    edge_id: str
    # 進む向きに見た始まりと終わりの標高（m）。
    start_elevation_m: float
    end_elevation_m: float
    elevation_gain_m: float
    elevation_loss_m: float
    average_grade: float | None
    # 進む向きに走ったときの一番急な登りと下りの勾配（%、どちらも0以上）。下りは、逆向きに走ったときの一番急な登りと
    # 同じ値。値が無ければNone。
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

    """

    numeric_ids: tuple[str, ...]
    numeric_values: EdgeValues  # shape=(n, len(numeric_ids)), NaN=欠損
    categorical_ids: tuple[str, ...]
    categorical_columns: tuple[CategoricalColumn, ...]  # categorical_idsと同じ並び
    # 区間そのものの値。グラフのオブジェクトから組み直さず、材料と同じクエリで受ける。
    distance_m: np.ndarray  # dtype=float64
    bearing_deg: np.ndarray  # dtype=float64, NaN=方位が決まらない
    mid_lat: np.ndarray  # dtype=float64
    mid_lon: np.ndarray  # dtype=float64

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
    # 区間の断面の点の間（所要時間が読む）。
    elevation_spans: ProfileSpans
    # 区間の、予報の10mの風を乗り手の高さへ直す倍率の引き口。
    wind_heights: WindHeights

    def __len__(self) -> int:
        return len(self.distance_m)


#: `EdgeMaterialArrays`のうち、区間の行をそのまま並べる配列の欄。区間の束を継ぐ・行を切り出す側はこれを回し、
#: 欄の名前を並べ直さない。分類の材料は列ごとに語彙が違うので含めない。
EDGE_ROW_ARRAY_FIELDS: tuple[str, ...] = tuple(
    field.name for field in fields(EdgeMaterialArrays) if field.type in (np.ndarray, EdgeValues)
)
