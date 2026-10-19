"""道の区分の全体の読み込みと、管理APIの入れ替え。

**プロセス内の全体（`domain/road_classes.py: replace_road_classes`）へ書くのはここだけ**（起動時の読み込みと、管理APIで書いた直後）。
反映はプロセス単位で、ほかのプロセスでの書き込みはこのプロセスへ届かない（単一プロセスのデプロイが前提）。
"""

import logging

from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.road_classes import RoadClassDefinitions, replace_road_classes
from app.infrastructure.road_class_repository import acquire_write_lock, read_road_classes, replace_road_class_rows

logger = logging.getLogger("ridecompass.road_classes")


class RoadClassRejectedError(ValueError):
    """書く全体が表の制約に通らなかった。文はDBの断りの文。"""


def _apply(definitions: RoadClassDefinitions) -> None:
    replace_road_classes(definitions)
    logger.info("道の区分を読み込みました classifications=%d", len(definitions.classifications))


async def refresh_road_classes(session: AsyncSession) -> None:
    """表の全体をプロセス内へ読み込む（起動時）。表が空なら区分は0件。表を読めなければ例外のまま起動を止める。"""
    _apply(await read_road_classes(session))


class RoadClassAdminService:
    """管理APIの全体の読みと入れ替え。入れ替えは1つの取引で、確定してからプロセス内へ反映する。"""

    def __init__(self, session: AsyncSession):
        self._session = session

    async def read(self) -> RoadClassDefinitions:
        return await read_road_classes(self._session)

    async def replace(self, definitions: RoadClassDefinitions) -> RoadClassDefinitions:
        """全体を入れ替え、入れ替えた後の全体を返す。"""
        session = self._session
        try:
            await acquire_write_lock(session)
            await replace_road_class_rows(session, definitions)
            after = await read_road_classes(session)
            await session.commit()
        except (IntegrityError, DataError) as error:
            await session.rollback()
            raise RoadClassRejectedError(str(error.orig)) from error
        except Exception:
            await session.rollback()
            raise
        _apply(after)
        return after
