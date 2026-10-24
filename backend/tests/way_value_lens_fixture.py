"""テストが軸の道ごとの値のレンズ（`services/dedicated_way_values.py: AxisWayValueLens`）を組むための道具。

レンズは本物を使い、外側の口（タイルの材料を読む口・材料を配るサービス）だけを代役にする。軸の集合は
組んだ時点の`AXIS_DEFINITIONS`で、テストが`tests/axis_system_fixture.py: replaced_axis_definitions`で決める。
"""

from collections.abc import Mapping

from app.domain.axis_definitions import copy_axis_definitions
from app.domain.dynamic_way_values import FeatureMaterials
from app.services.dedicated_way_values import AxisWayValueLens


class FakeFeatureMaterials:
    """タイルの材料を読む口（`services/feature_materials.py: FeatureMaterialService`）の代役。
    どのタイルにも同じ`materials`を返す（`None`は読めないタイル）。区間の材料は読めない。"""

    def __init__(self, materials: FeatureMaterials | None = None):
        self._materials = materials

    async def materials(self, z, x, y):
        return self._materials

    async def segments(self, z, x, y):
        return None


def axis_way_value_lens(axis_id: str, materials, services: Mapping[str, object] | None = None) -> AxisWayValueLens:
    """今の`AXIS_DEFINITIONS`で軸`axis_id`を引くレンズ。`materials`はタイルの材料を読む口、`services`は材料id→配信サービス。"""
    return AxisWayValueLens(axis_id, copy_axis_definitions(), materials, dict(services or {}).__getitem__)
