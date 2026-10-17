"""ルートの区間に載せる道の区分（地図の道の線のレイヤと「緑と水」）の値を、道路網の行から読む。

鍵は地図のレイヤのid（＝一次属性のid）。値は地図がそのレイヤを塗るのと同じ値で、色と呼び名は受け取る側が
地図と同じ宣言（一次属性の表示の軸・土地被覆のクラス）から引く。
- 道の線のレイヤは、表示の軸の値をタイルへ載せる材料の値。真偽の材料は、タイルと同じく該当だけを`True`にし、
  非該当と欠損は値なし（None）にする。
- 「緑と水」は、割合が最も多いクラスの割合の材料のid（`domain/landcover.py: LandcoverClass.percent_field`）。
  同率は`domain/landcover.py: LANDCOVER_CLASSES`の並びで先のクラスを取る。
"""

import math
from dataclasses import dataclass

from app.domain.landcover import LANDCOVER_CLASSES
from app.domain.material_catalog import MaterialSpec, display_axis_material
from app.domain.primary_attributes import ATTR_LANDCOVER, PRIMARY_ATTRIBUTES
from app.domain.road_network import RoadNetwork

RoadClassValue = str | bool | None


def _line_layer_materials() -> dict[str, MaterialSpec]:
    """道の線のレイヤ（表示の軸を持つ線の一次属性）→色を決める軸の値を載せる材料。"""
    materials = {}
    for attr in PRIMARY_ATTRIBUTES:
        if attr.geometry != "line" or not attr.display_axes:
            continue
        spec = display_axis_material(attr, attr.display_axes[0].property)
        if spec is None or spec.dtype not in ("categorical", "boolean"):
            raise ValueError(f"道の線のレイヤ{attr.attr_id}の値をタイルへ載せる、分類か真偽の材料が無い")
        materials[attr.attr_id] = spec
    return materials


LINE_LAYER_MATERIALS: dict[str, MaterialSpec] = _line_layer_materials()
#: 区間に載せるレイヤのid。
ROAD_CLASS_LAYER_IDS: tuple[str, ...] = (*LINE_LAYER_MATERIALS, ATTR_LANDCOVER.attr_id)


@dataclass(frozen=True)
class RoadClassReader:
    """道路網の行から、レイヤ→区分の値を読む。列の位置は道路網ごとに1度だけ引く。"""

    network: RoadNetwork
    categorical_columns: dict[str, int]
    boolean_columns: dict[str, int]
    landcover_columns: tuple[tuple[str, int], ...]

    @classmethod
    def of(cls, network: RoadNetwork) -> "RoadClassReader":
        return cls(
            network=network,
            categorical_columns={
                layer: network.categorical_ids.index(spec.material_id)
                for layer, spec in LINE_LAYER_MATERIALS.items()
                if spec.dtype == "categorical"
            },
            boolean_columns={
                layer: network.numeric_ids.index(spec.material_id)
                for layer, spec in LINE_LAYER_MATERIALS.items()
                if spec.dtype == "boolean"
            },
            landcover_columns=tuple(
                (c.percent_field, network.numeric_ids.index(c.percent_field)) for c in LANDCOVER_CLASSES
            ),
        )

    def values_at(self, row: int) -> dict[str, RoadClassValue]:
        """道路網全体の行`row`の区間の、レイヤ→区分の値。"""
        network = self.network
        values: dict[str, RoadClassValue] = {}
        for layer in LINE_LAYER_MATERIALS:
            if layer in self.categorical_columns:
                column = self.categorical_columns[layer]
                values[layer] = network.categorical_vocab[column][int(network.categorical_codes[row, column])]
            else:
                values[layer] = True if network.numeric_values[row, self.boolean_columns[layer]] == 1.0 else None
        values[ATTR_LANDCOVER.attr_id] = self._dominant_landcover(row)
        return values

    def _dominant_landcover(self, row: int) -> str | None:
        dominant, largest = None, -math.inf
        for percent_field, column in self.landcover_columns:
            share = float(self.network.numeric_values[row, column])
            if not math.isnan(share) and share > largest:
                dominant, largest = percent_field, share
        return dominant
