"""費用の軸の定義の表の、全体の読みと全体の入れ替え。書く関数はcommitしない（取引の区切りは
`services/cost_axis_service.py`が持つ）。"""

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.cost_axes import CostAxisDefinitions
from app.infrastructure.cost_axis_models import CostAxisDefinitionsRow


async def read_cost_axes(session: AsyncSession) -> CostAxisDefinitions | None:
    """表の全体。行が無ければNone。"""
    row = await session.scalar(select(CostAxisDefinitionsRow))
    return None if row is None else CostAxisDefinitions.model_validate(row.definitions)


async def replace_cost_axes_row(session: AsyncSession, definitions: CostAxisDefinitions) -> None:
    """全体を入れ替える（行が無ければ入れる）。"""
    values = {"only_one": True, "definitions": definitions.model_dump(mode="json")}
    statement = insert(CostAxisDefinitionsRow).values(values)
    await session.execute(statement.on_conflict_do_update(
        index_elements=["only_one"], set_={"definitions": statement.excluded.definitions, "updated_at": func.now()}))
