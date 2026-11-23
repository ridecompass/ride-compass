"""地図のフィーチャー（路面タイルの`feature_key`の単位）ごとの材料（地図の道の線の層が区分を塗る入力）。"""

from dataclasses import dataclass

import numpy as np

from app.domain.attributes import CategoricalColumn, MaterialColumn
from app.domain.material_catalog import MATERIAL_CATALOG


@dataclass(frozen=True)
class FeatureMaterials:
    """フィーチャーごとの材料。`columns`の各列は`feature_keys`と同じ並び（数値・真偽はfloatの配列で欠損は
    NaN、分類は`CategoricalColumn`）。"""

    feature_keys: tuple[str, ...]
    columns: dict[str, MaterialColumn]

    def __len__(self) -> int:
        return len(self.feature_keys)

    def tile_properties(self, row: int) -> dict[str, str | float | bool]:
        """`row`番目のフィーチャーの、タイルの名前（`MaterialSpec.tile_property`）で出す材料。真偽は該当だけを`true`で
        出し、値の無い材料と非該当の真偽は出さない（小窓は無いことを値の無いこととして読む）。"""
        properties: dict[str, str | float | bool] = {}
        for material_id, spec in MATERIAL_CATALOG.items():
            if spec.tile_property is None or material_id not in self.columns:
                continue
            column = self.columns[material_id]
            if isinstance(column, CategoricalColumn):
                if (text := column.value_at(row)) is not None:
                    properties[spec.tile_property] = text
                continue
            value = float(column[row])
            if np.isnan(value):
                continue
            if spec.dtype == "boolean":
                if value:
                    properties[spec.tile_property] = True
                continue
            properties[spec.tile_property] = value
        return properties
