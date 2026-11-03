"""費用の軸の定義の全体の読み込みと、管理APIの入れ替え。

**プロセス内の全体（`domain/cost_axes.py: replace_cost_axes`）へ書くのはここだけ**（起動時の読み込みと、管理APIで書いた直後）。
定義は道の区分（区分の材料の区分の一覧）に照らして確かめるので、区分を読んだ後に読む（`services/definitions_loading.py`）。
"""

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.cost_axes import CostAxisDefinitions, check_cost_axes, replace_cost_axes
from app.domain.road_classes import RoadClassDefinitions, current_road_classes
from app.infrastructure.axis_definition_repository import AxisDefinitionRepository
from app.infrastructure.cost_axis_repository import read_cost_axes, replace_cost_axes_row
from app.infrastructure.road_class_repository import read_road_classes

logger = logging.getLogger("ridecompass.cost_axes")


class CostAxesRejectedError(ValueError):
    """書く全体を断った。文は運用者が読む断りの文。"""


def check_cost_axes_against(definitions: CostAxisDefinitions | None, road_classes: RoadClassDefinitions) -> list[str]:
    """費用の軸の定義が、道の区分に照らして通るか（定義が無ければ通る）。道の区分を入れ替える側も、今の定義をこれで通し直す。"""
    return [] if definitions is None else check_cost_axes(definitions, road_classes)


async def refresh_cost_axes(session: AsyncSession) -> None:
    """表の全体をプロセス内へ読み込む（起動時。区分を読んだ後）。行が無ければNone。通らない定義なら例外のまま起動を止める
    ——バックアップから戻した行は管理APIを通らないので、ここで初めて確かめる。"""
    definitions = await read_cost_axes(session)
    problems = check_cost_axes_against(definitions, current_road_classes())
    if problems:
        raise RuntimeError(f"費用の軸の定義を読み込めません: {'／'.join(problems)}")
    replace_cost_axes(definitions)
    logger.info("費用の軸の定義を読み込みました axes=%s", "-" if definitions is None else len(definitions.axis_ids()))


class CostAxisAdminService:
    """管理APIの全体の読みと入れ替え。入れ替えは1つの取引で、確定してからプロセス内へ反映する。"""

    def __init__(self, session: AsyncSession, axes: AxisDefinitionRepository):
        self._session = session
        self._axes = axes

    async def read(self) -> CostAxisDefinitions | None:
        return await read_cost_axes(self._session)

    async def replace(self, definitions: CostAxisDefinitions) -> CostAxisDefinitions:
        """全体を入れ替え、書いた全体を返す。道の区分の書き込みと同じ鍵を取ってから区分に照らす——取らないと、確かめてから
        確定するまでの間に区分が入れ替わる。"""
        await self._axes.acquire_write_lock()
        # プロセス内の区分ではなくDBの区分に照らす——プロセス内は確定の後に書き換わるので、鍵の外れた隙に入れ替わった区分を
        # 見落とす。
        problems = check_cost_axes(definitions, await read_road_classes(self._session))
        if problems:
            await self._session.rollback()
            raise CostAxesRejectedError(f"費用の軸の定義が通りません（{'／'.join(problems)}）")
        await replace_cost_axes_row(self._session, definitions)
        await self._session.commit()
        replace_cost_axes(definitions)
        return definitions
