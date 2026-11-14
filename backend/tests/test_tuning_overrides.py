"""較正値の値の表（`infrastructure/tuning_overrides.py`）のテスト。

ここで見ないもの:
- HTTPの受け口 → `test_tuning_admin_routes.py`、派生バッチが同じ値を読むこと → `test_derive_cli.py`
"""


import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import tuning
from app.infrastructure.tuning_overrides import TuningOverrideRow, TuningOverrideStore, load_tuning_values
from app.services.tuning_service import refresh_tuning_values
from tests.tuning_fixture import TUNING

pytestmark = pytest.mark.asyncio(loop_scope="module")

_PARAM = "turn.right_seconds"


async def test_a_written_value_reaches_the_running_value(road_graph_session: AsyncSession):
    """書いた値が、DBから読み込むとプロセス内の`TUNING_VALUES`まで届いて消費者に効く。"""
    changed = TUNING[_PARAM] + 7.0
    await TuningOverrideStore(road_graph_session).set_value(_PARAM, changed)
    await road_graph_session.commit()

    await refresh_tuning_values(road_graph_session)

    assert tuning.tuning_value(_PARAM) == changed


async def test_a_declared_value_without_a_row_stops_naming_the_id(road_graph_session: AsyncSession):
    """宣言にあるidの行が無ければ、そのidを名指して止まる（起動しない）——コードは値を持たず、代わりの値で動かない。"""
    await road_graph_session.execute(delete(TuningOverrideRow).where(TuningOverrideRow.param_id == _PARAM))

    with pytest.raises(RuntimeError, match=_PARAM):
        await load_tuning_values(road_graph_session)


async def test_a_row_whose_id_left_the_declaration_does_not_stop_loading(road_graph_session: AsyncSession):
    """宣言から消した較正値の行が残っていても読み込める——行はデプロイの後に消すので、その間も起動する。"""
    await TuningOverrideStore(road_graph_session).set_value("removed.parameter", 1.0)

    assert await load_tuning_values(road_graph_session) == TUNING
