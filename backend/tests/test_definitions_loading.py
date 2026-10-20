"""`services/definitions_loading.py: refresh_definitions`: DBの区分から作る材料を指す軸が、読み込まれる。

ここで見ないもの:
- 軸定義の読み込みの検算（0行・未知の材料） → `test_axis_registry_service.py`
- 較正値の読み込み → `test_tuning_overrides.py`
- 起動時・ベンチ・道具がこの関数だけを通ること → `tests/structure/test_definitions_loading_entry.py`
"""

import pytest

from app.domain.axis_definitions import AXIS_DEFINITIONS, CategoricalShape
from app.domain.material_catalog import MATERIAL_CATALOG
from app.domain.road_classes import EMPTY_ROAD_CLASSES, class_material_id
from app.infrastructure.axis_definition_repository import AxisDefinitionRepository
from app.infrastructure.road_class_repository import replace_road_class_rows
from app.services.definitions_loading import refresh_definitions
from tests.axis_system_fixture import axis_definitions_snapshot, shaped_axis
from tests.road_class_fixture import classification, fact_is, replaced_road_classes, road_classes

pytestmark = pytest.mark.asyncio(loop_scope="module")


async def test_an_axis_reading_a_road_class_is_loaded(road_graph_session):
    """プロセスの区分が空のままでも、DBの区分を指す軸が読み込まれる（読めないと、起動も、本番を測る道具も止まる）。"""
    await replace_road_class_rows(
        road_graph_session, road_classes({"surface": classification({"paved": [fact_is(next(iter(MATERIAL_CATALOG)), "asphalt")]})}),
    )
    axis = shaped_axis(CategoricalShape(material=class_material_id("surface"), mapping={"paved": 100.0}))
    await AxisDefinitionRepository(road_graph_session).upsert(axis, 0)
    await road_graph_session.commit()

    with replaced_road_classes(EMPTY_ROAD_CLASSES), axis_definitions_snapshot():
        await refresh_definitions(road_graph_session, AxisDefinitionRepository(road_graph_session))

        assert set(AXIS_DEFINITIONS) == {axis.axis_id}
