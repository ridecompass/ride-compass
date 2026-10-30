"""道の区分の全体の読み込みと、管理APIの入れ替え。

**プロセス内の全体（`domain/road_classes.py: replace_road_classes`）へ書くのはここだけ**（起動時の読み込みと、管理APIで書いた直後）。
反映はプロセス単位で、ほかのプロセスでの書き込みはこのプロセスへ届かない（単一プロセスのデプロイが前提）。
"""

import logging

from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.axis_definitions import AxisDefinition, missing_class_materials, named_references, unknown_class_values
from app.domain.road_classes import RoadClassDefinitions, replace_road_classes, undeclared_references
from app.infrastructure.axis_definition_repository import AxisDefinitionRepository
from app.infrastructure.road_class_repository import read_road_classes, replace_road_class_rows

logger = logging.getLogger("ridecompass.road_classes")


class RoadClassRejectedError(ValueError):
    """書く全体を断った。文は運用者が読む断りの文。"""


def _apply(definitions: RoadClassDefinitions) -> None:
    replace_road_classes(definitions)
    logger.info("道の区分を読み込みました classifications=%d", len(definitions.classifications))


async def refresh_road_classes(session: AsyncSession) -> None:
    """表の全体をプロセス内へ読み込む（起動時）。表が空なら区分は0件。表を読めなければ例外のまま起動を止める。"""
    _apply(await read_road_classes(session))


def _check_writable(definitions: RoadClassDefinitions, axes: dict[str, AxisDefinition]) -> None:
    """書く全体が、コードの宣言に無い名を指さず、確定しても次の起動で全軸を読み込め、軸が名指す区分の値がどの道にも当たらなく
    ならないか。通らなければ`RoadClassRejectedError`。"""
    undeclared = undeclared_references(definitions)
    if undeclared:
        raise RoadClassRejectedError(f"コードの宣言に無い名を指しています（{'／'.join(undeclared)}）")
    users = {axis_id: missing for axis_id, axis in axes.items() if (missing := missing_class_materials(axis, definitions))}
    if users:
        reasons = "／".join(
            f"{named_references([axis_id], axes)}が{named_references(missing, axes)}を使っています" for axis_id, missing in users.items()
        )
        raise RoadClassRejectedError(
            f"この入れ替えを確定すると、次の起動で読み込めない軸ができるため確定しません（{reasons}）。"
            "先に軸の材料から外してください"
        )
    stale = {axis_id: unknown for axis_id, axis in axes.items() if (unknown := unknown_class_values(axis, definitions))}
    if stale:
        reasons = "／".join(
            f"{named_references([axis_id], axes)}が{named_references([material], axes)}の値「{name}」を使っています"
            for axis_id, unknown in stale.items()
            for material, name in unknown
        )
        raise RoadClassRejectedError(
            f"軸が名指す区分が無くなるため確定しません（{reasons}）。"
            "区分の鍵を改めるときは、先に軸の値を直してください"
        )


class RoadClassAdminService:
    """管理APIの全体の読みと入れ替え。入れ替えは1つの取引で、確定してからプロセス内へ反映する。"""

    def __init__(self, session: AsyncSession, axes: AxisDefinitionRepository):
        self._session = session
        self._axes = axes

    async def read(self) -> RoadClassDefinitions:
        return await read_road_classes(self._session)

    async def replace(self, definitions: RoadClassDefinitions) -> RoadClassDefinitions:
        """全体を入れ替え、書いた全体を返す。

        軸の書き込みの鍵を取ってから軸を読む——取らないと、確かめてから確定するまでの間に、消す分け方を指す軸が書ける。
        """
        session, axes = self._session, self._axes
        try:
            await axes.acquire_write_lock()
            _check_writable(definitions, await axes.list_all())
            await replace_road_class_rows(session, definitions)
            await session.commit()
        except (IntegrityError, DataError) as error:
            await session.rollback()
            raise RoadClassRejectedError(f"表の制約に通りません: {error.orig}") from error
        except RoadClassRejectedError:
            await session.rollback()
            raise
        _apply(definitions)
        return definitions
