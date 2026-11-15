"""`services/definitions_loading.py: refresh_definitions`: DBの区分から作る材料を指す費用の軸の定義が読み込まれ、コードの宣言に無い
材料・体力の軸を指す定義は、それを名指して起動を止める。

ここで見ないもの:
- 費用の軸の定義の検算（材料・区分の重さ） → `test_cost_axes.py`
- 較正値の読み込み → `test_tuning_overrides.py`
- 起動時・ベンチ・道具がこの関数だけを通ること → `tests/structure/test_definitions_loading_entry.py`
"""

import pytest
from pydantic import ValidationError
from sqlalchemy import insert

from app.domain.cost_axes import CostAxisDefinitions, current_cost_axes
from app.domain.road_classes import EMPTY_ROAD_CLASSES, class_material_id
from app.infrastructure.cost_axis_models import CostAxisDefinitionsRow
from app.infrastructure.cost_axis_repository import replace_cost_axes_row
from app.infrastructure.road_class_repository import replace_road_class_rows
from app.services.definitions_loading import refresh_definitions
from tests.cost_axes_fixture import cost_axes
from tests.road_class_fixture import classification, fact_is, replaced_road_classes, road_classes

pytestmark = pytest.mark.asyncio(loop_scope="module")


async def test_cost_axes_reading_a_road_class_are_loaded(road_graph_session):
    """プロセスの区分が空のままでも、DBの区分を指す費用の軸の定義が読み込まれる（読めないと、起動も、本番を測る道具も
    止まる）。"""
    await replace_road_class_rows(road_graph_session, road_classes({"surface": classification({"paved": [fact_is("highway", "residential")]})}))
    standard = cost_axes().model_dump(mode="json")
    definitions = CostAxisDefinitions.model_validate({**standard, "burden": {"surface": {**standard["total_lens"], "burden": {
        "kind": "categorical", "material": class_material_id("surface"), "per_km": {"paved": 1.0}}}}})
    await replace_cost_axes_row(road_graph_session, definitions)
    await road_graph_session.commit()

    with replaced_road_classes(EMPTY_ROAD_CLASSES):
        await refresh_definitions(road_graph_session)

        assert current_cost_axes() == definitions


@pytest.mark.parametrize(
    ("change", "named"),
    [
        (lambda d: {**d, "burden": {"lighting": {**d["total_lens"], "burden": {
            "kind": "linear", "material": "removed_material", "points": [[0.0, 1.0]]}}}}, "removed_material"),
        (lambda d: {**d, "effort": {**d["effort"], "removed_axis": d["total_lens"]}}, "removed_axis"),
    ],
    ids=["材料", "体力の軸"],
)
async def test_definitions_naming_what_left_the_code_stop_the_start_naming_it(road_graph_session, change, named):
    """コードの宣言から消した材料・体力の軸を保存済みの定義が指していたら、外したり既定へ戻したりせず、それを名指して止まる
    （運用者が定義を直してから起動する）。"""
    raw = change(cost_axes().model_dump(mode="json"))
    await road_graph_session.execute(insert(CostAxisDefinitionsRow).values(only_one=True, definitions=raw))
    await road_graph_session.commit()

    with pytest.raises((RuntimeError, ValidationError), match=named):
        await refresh_definitions(road_graph_session)
