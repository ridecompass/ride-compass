"""探索の材料の表（`SearchMaterials`）。

探索範囲の区間ごとの、所要時間と費用の式が読む材料の列・探索の除外の材料・区間の幾何を、1つの行順に揃えて持つ。
入力はDBが導出した材料の列（`EdgeMaterialColumns`）で、このモジュールは材料の値をどう求めるかを知らない。費用の式
（`domain/leg_costs.py`）は探索範囲の評価の中身をここから読み、探索（`services/road_graph_engine.py`）は評価の中身を知らない。
"""

from dataclasses import dataclass
from typing import Iterator, Mapping, Sequence

import numpy as np

from app.domain.attributes import CategoricalColumn, EdgeMaterialColumns, MaterialColumn
from app.domain.cycling_speed import travel_model_material_ids
from app.domain.elevation_profile import ElevationProfiles
from app.domain.hard_filters import hard_filtered
from app.domain.material_catalog import material_spec
from app.domain.road_classes import CLASS_MATERIAL_PREFIX
from app.domain.search_graph import EDGE_VALUE_DTYPE
from app.domain.stopwatch import add_elapsed_ms, start_timer


class _ColumnsOrEmpty(Mapping[str, MaterialColumn]):
    """材料id→列。`columns`に無い材料カタログの材料は、値の無い列（`_empty_material_column`）を返す——読む材料を先に並べず、
    読まれたときに埋める。並べ上げる（`iter`）のは`columns`の材料だけ。"""

    def __init__(self, columns: Mapping[str, MaterialColumn], n: int) -> None:
        self._columns = columns
        self._n = n
        self._empty: dict[str, MaterialColumn] = {}

    def __getitem__(self, material_id: str) -> MaterialColumn:
        try:
            return self._columns[material_id]
        except KeyError:
            pass
        if (column := self._empty.get(material_id)) is None:
            column = _empty_material_column(material_id, self._n)
            if column is None:
                raise KeyError(material_id) from None
            self._empty[material_id] = column
        return column

    def __iter__(self) -> Iterator[str]:
        return iter(self._columns)

    def __len__(self) -> int:
        return len(self._columns)


def _empty_material_column(material_id: str, n: int) -> MaterialColumn | None:
    """`MATERIAL_CATALOG`にある材料の、値の無い区間`n`本ぶんの列。カタログに無ければNone。"""
    spec = material_spec(material_id)
    if spec is None:
        return None
    if spec.dtype == "categorical":
        return CategoricalColumn.empty(n)
    return np.full(n, np.nan)  # numeric・boolean（真偽も数値の行列と同じく1.0/0.0/NaNで持つ）


@dataclass(frozen=True, slots=True)
class SearchMaterials:
    """探索範囲の区間ごとの材料の表。全ての配列は同じ行順（切り出した区間の順）で揃う。

    数値の材料は「id×区間」の向きの行列で持つ（1つのidの区間の並びが連続する。読む側は材料ごとに列を読むため）。
    """

    distance_m: np.ndarray
    bearing_deg: np.ndarray
    # 0次ハードフィルタに当たる区間と、区分の列（鍵は`domain/road_classes.py: class_material_id`）。リクエストごとに
    # 変わる絞り込みと割り増しは`domain/hard_filters.py: compute_search_exclusion`が決める。
    hard_filtered: np.ndarray
    road_classes: dict[str, CategoricalColumn]
    # Edge中点の緯度経度（from/toノードの平均）。探索前に各Edgeの通過予定時刻を基準点からの
    # 直線距離で推定し、風の予報の格子点を引くために使う。
    mid_lat: np.ndarray
    mid_lon: np.ndarray
    # 所要時間と費用の式が読む数値の材料（`material_ids`の順の行）と、区分の材料（語彙への番号の列）。
    material_ids: list[str]
    material_values: np.ndarray
    categorical_material_ids: list[str]
    categorical_material_columns: list[CategoricalColumn]
    # 区間の断面の点（所要時間が点の間ごとに速さを解く。`domain/elevation_profile.py`）。
    elevation_profiles: ElevationProfiles

    def __post_init__(self) -> None:
        """行と列が揃っていることを、組み立てた場所で確かめる。揃っていないまま先へ進むと、行がずれた区間のコストを
        **別のEdgeのもの**として返す。例外にならない。"""
        rows = len(self.distance_m)
        if self.material_values.shape[0] != len(self.material_ids):
            raise ValueError(f"材料の表のidの数が行列と違います: {self.material_values.shape[0]}, {len(self.material_ids)}")
        if len(self.categorical_material_columns) != len(self.categorical_material_ids):
            raise ValueError(f"区分の材料の列の数がidの数と違います: {len(self.categorical_material_columns)}, "
                             f"{len(self.categorical_material_ids)}")
        # 所要時間の入力が欠けた表を通すと、読む側はその材料を区間ごとの欠損と区別できず、
        # 全区間を取込の範囲全体の平均で数え、道ごとの坂・待ちの違いを黙って失う。
        missing_inputs = set(travel_model_material_ids()) - {*self.material_ids, *self.categorical_material_ids}
        if missing_inputs:
            raise ValueError(f"材料の表に所要時間が読む材料の列がありません: {sorted(missing_inputs)}")
        wrong_rows = {
            name: array.shape
            for name, array in (
                ("distance_m", self.distance_m),
                ("bearing_deg", self.bearing_deg),
                ("mid_lat", self.mid_lat),
                ("mid_lon", self.mid_lon),
                ("hard_filtered", self.hard_filtered),
                ("material_values", self.material_values.T),
                *((f"road_classes[{key}]", column.codes) for key, column in self.road_classes.items()),
                *((f"categorical_material_columns[{material_id}]", column.codes) for material_id, column in zip(
                    self.categorical_material_ids, self.categorical_material_columns)),
            )
            if array.shape[0] != rows
        }
        if wrong_rows:
            raise ValueError(f"材料の表の行数が区間数と違います 区間={rows} {wrong_rows}")


def build_search_materials(
    materials: EdgeMaterialColumns, steps_ms: dict[str, int], cost_material_ids: Sequence[str],
) -> SearchMaterials:
    """切り出した範囲の材料から`SearchMaterials`を組む（生成のたびに1回）。段ごとの所要時間を`steps_ms`へ足す。

    運ぶ材料は、所要時間が読む材料（`domain/cycling_speed.py: travel_model_material_ids`）と費用の式が読む材料
    （`cost_material_ids`。道のストレスの軸の材料）。DBに無い材料カタログの材料は、値の無い列（`_empty_material_column`）で埋める。
    探索の除外は0次ハードフィルタの当たりと区分の列だけを持つ。
    """
    started = start_timer()
    n = len(materials)
    columns = _ColumnsOrEmpty(materials.columns, n)
    carried = dict.fromkeys((*travel_model_material_ids(), *cost_material_ids))
    numeric = {material_id: values for material_id in carried if isinstance(values := columns.get(material_id), np.ndarray)}
    categorical = {
        material_id: column for material_id in carried if isinstance(column := columns.get(material_id), CategoricalColumn)
    }
    material_values = np.empty((len(numeric), n), dtype=EDGE_VALUE_DTYPE)
    for i, values in enumerate(numeric.values()):
        material_values[i] = values
    table = SearchMaterials(
        distance_m=materials.distance_m,
        bearing_deg=materials.bearing_deg,
        hard_filtered=hard_filtered(columns, n),
        road_classes={
            material_id: column for material_id in columns
            if material_id.startswith(CLASS_MATERIAL_PREFIX) and isinstance(column := columns[material_id], CategoricalColumn)
        },
        mid_lat=materials.mid_lat,
        mid_lon=materials.mid_lon,
        material_ids=list(numeric),
        material_values=material_values,
        categorical_material_ids=list(categorical),
        categorical_material_columns=list(categorical.values()),
        elevation_profiles=materials.elevation_profiles,
    )
    add_elapsed_ms(steps_ms, "stack", started)
    return table
