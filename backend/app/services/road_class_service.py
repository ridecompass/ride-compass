"""道の区分の全体の読み込みと、管理APIの入れ替え。

**プロセス内の全体（`domain/road_classes.py: replace_road_classes`）へ書くのはここだけ**（起動時の読み込みと、管理APIで書いた直後）。
反映はプロセス単位で、ほかのプロセスでの書き込みはこのプロセスへ届かない（単一プロセスのデプロイが前提）。
"""

import logging

from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.cost_axes import CostAxisDefinitions, check_cost_axes
from app.domain.road_classes import RoadClassDefinitions, replace_road_classes, undeclared_references
from app.infrastructure.cost_axis_repository import read_cost_axes
from app.infrastructure.definition_write_lock import acquire_definition_write_lock
from app.infrastructure.road_class_repository import read_road_classes, replace_road_class_rows
from app.services.cost_axis_service import warn_surplus_class_weights

logger = logging.getLogger("ridecompass.road_classes")


class RoadClassRejectedError(ValueError):
    """書く全体を断った。文は運用者が読む断りの文。"""


def _apply(definitions: RoadClassDefinitions) -> None:
    replace_road_classes(definitions)
    logger.info("道の区分を読み込みました classifications=%d", len(definitions.classifications))


async def refresh_road_classes(session: AsyncSession) -> None:
    """表の全体をプロセス内へ読み込む（起動時）。表が空なら区分は0件。表を読めないか、コードの宣言に無い名を指していれば
    （`undeclared_references`）、名指して起動を止める。バックアップから戻した行は管理APIを通らないので、ここで初めて確かめる。"""
    definitions = await read_road_classes(session)
    undeclared = undeclared_references(definitions)
    if undeclared:
        raise RuntimeError(f"道の区分を読み込めません: コードの宣言に無い名を指しています（{'／'.join(undeclared)}）")
    _apply(definitions)


def _check_writable(definitions: RoadClassDefinitions, cost_axes: CostAxisDefinitions | None) -> None:
    """書く全体が、コードの宣言に無い名を指さず、確定しても次の起動で費用の軸の定義を読み込めるか。通らなければ
    `RoadClassRejectedError`。"""
    undeclared = undeclared_references(definitions)
    if undeclared:
        raise RoadClassRejectedError(f"コードの宣言に無い名を指しています（{'／'.join(undeclared)}）")
    if cost_axes is None:
        return
    cost_axis_problems = check_cost_axes(cost_axes, definitions)
    if cost_axis_problems:
        raise RoadClassRejectedError(
            f"費用の軸の定義が新しい区分に合わなくなるため確定しません（{'／'.join(cost_axis_problems)}）。"
            "先に費用の軸の定義を新しい区分に合わせてください（足す区分の重さは、区分より先に書ける）"
        )


class RoadClassAdminService:
    """管理APIの全体の読みと入れ替え。入れ替えは1つの取引で、確定してからプロセス内へ反映する。"""

    def __init__(self, session: AsyncSession):
        self._session = session

    async def read(self) -> RoadClassDefinitions:
        return await read_road_classes(self._session)

    async def replace(self, definitions: RoadClassDefinitions) -> RoadClassDefinitions:
        """全体を入れ替え、書いた全体を返す。

        定義の書き込みの鍵を取ってから費用の軸を読む——取らないと、確かめてから確定するまでの間に、消す区分を指す費用の軸が
        書ける。
        """
        session = self._session
        try:
            await acquire_definition_write_lock(session)
            cost_axes = await read_cost_axes(session)
            _check_writable(definitions, cost_axes)
            await replace_road_class_rows(session, definitions)
            await session.commit()
        except (IntegrityError, DataError) as error:
            await session.rollback()
            raise RoadClassRejectedError(f"表の制約に通りません: {error.orig}") from error
        except RoadClassRejectedError:
            await session.rollback()
            raise
        _apply(definitions)
        if cost_axes is not None:
            warn_surplus_class_weights(cost_axes, definitions)
        return definitions
