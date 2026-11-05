"""費用の軸の定義の全体の読み込みと、管理APIの入れ替え。

**プロセス内の全体（`domain/cost_axes.py: replace_cost_axes`）へ書くのはここだけ**（起動時の読み込みと、管理APIで書いた直後）。
定義は道の区分（区分の材料の区分の一覧）に照らして確かめるので、区分を読んだ後に読む（`services/definitions_loading.py`）。
"""

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.cost_axes import CostAxisDefinitions, check_cost_axes, replace_cost_axes
from app.domain.road_classes import current_road_classes
from app.infrastructure.cost_axis_repository import read_cost_axes, replace_cost_axes_row
from app.infrastructure.definition_write_lock import acquire_definition_write_lock
from app.infrastructure.road_class_repository import read_road_classes

logger = logging.getLogger("ridecompass.cost_axes")


class CostAxesRejectedError(ValueError):
    """書く全体を断った。文は運用者が読む断りの文。"""


async def refresh_cost_axes(session: AsyncSession) -> None:
    """表の全体をプロセス内へ読み込む（起動時。区分を読んだ後）。行が無いか、通らない定義なら例外のまま起動を止める——
    探索・地図のレンズ・応答の内訳はどれも費用の軸の定義から組むので、無いまま動く経路を持たない。バックアップから戻した行は
    管理APIを通らないので、ここで初めて確かめる。"""
    definitions = await read_cost_axes(session)
    if definitions is None:
        raise RuntimeError("費用の軸の定義が表にありません（管理データのバックアップから戻すか、定義を入れてから起動する）")
    problems = check_cost_axes(definitions, current_road_classes())
    if problems:
        raise RuntimeError(f"費用の軸の定義を読み込めません: {'／'.join(problems)}")
    replace_cost_axes(definitions)
    logger.info("費用の軸の定義を読み込みました axes=%d", len(definitions.effort) + len(definitions.burden))


class CostAxisAdminService:
    """管理APIの全体の読みと入れ替え。入れ替えは1つの取引で、確定してからプロセス内へ反映する。"""

    def __init__(self, session: AsyncSession):
        self._session = session

    async def read(self) -> CostAxisDefinitions | None:
        return await read_cost_axes(self._session)

    async def replace(self, definitions: CostAxisDefinitions) -> CostAxisDefinitions:
        """全体を入れ替え、書いた全体を返す。道の区分の書き込みと同じ鍵を取ってから区分に照らす——取らないと、確かめてから
        確定するまでの間に区分が入れ替わる。"""
        await acquire_definition_write_lock(self._session)
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
