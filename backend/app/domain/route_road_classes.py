"""ルートの区間に載せる道の区分（分け方ごとの区分と「緑と水」）を、切り出した道路網の行から読む。

鍵は分け方（地図の道の線の層のid）と「緑と水」の層のid。呼び名と色は、受け取る側が軸カタログの区分と土地被覆のクラスから引く。
- 分け方の値は区分の鍵。どの区分にも入らない道は値なし（None）。
- 「緑と水」は、割合が最も多いクラスの割合の材料のid（`domain/landcover.py: LandcoverClass.percent_field`）。
  同率は`domain/landcover.py: LANDCOVER_CLASSES`の並びで先のクラスを取る。
"""

import math
from dataclasses import dataclass

from app.domain.attributes import CategoricalColumn
from app.domain.landcover import LANDCOVER_CLASSES
from app.domain.primary_attributes import ATTR_LANDCOVER
from app.domain.road_classes import CLASS_MATERIAL_PREFIX
from app.domain.road_network import RoadSlice


@dataclass(frozen=True)
class SegmentClassReader:
    """切り出した道路網の区間から、分け方・「緑と水」→区分を読む。列は切り出しごとに1度だけ引く。"""

    road: RoadSlice
    classes: tuple[tuple[str, CategoricalColumn], ...]
    landcover_columns: tuple[tuple[str, int], ...]

    @classmethod
    def of(cls, road: RoadSlice) -> "SegmentClassReader":
        network = road.network
        return cls(
            road=road,
            classes=tuple(
                (material_id.removeprefix(CLASS_MATERIAL_PREFIX), column)
                for material_id, column in road.classes.items()
                if material_id.startswith(CLASS_MATERIAL_PREFIX)
            ),
            landcover_columns=tuple(
                (c.percent_field, network.numeric_ids.index(c.percent_field)) for c in LANDCOVER_CLASSES
            ),
        )

    def values_at(self, index: int) -> dict[str, str | None]:
        """切り出しの中の`index`番目の区間の、分け方・「緑と水」→区分。"""
        row = int(self.road.rows[index])
        values: dict[str, str | None] = {key: column.value_at(row) for key, column in self.classes}
        values[ATTR_LANDCOVER.attr_id] = self._dominant_landcover(row)
        return values

    def _dominant_landcover(self, row: int) -> str | None:
        dominant, largest = None, -math.inf
        for percent_field, column in self.landcover_columns:
            share = float(self.road.network.numeric_values[row, column])
            if not math.isnan(share) and share > largest:
                dominant, largest = percent_field, share
        return dominant
