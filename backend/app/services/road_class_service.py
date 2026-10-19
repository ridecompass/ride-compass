"""道の区分の群の起動時の読み込みと、管理APIの書き込み（DBへの反映とプロセス内の群の差し替え）。

反映はプロセス単位で、他プロセスでの編集はこのプロセスへ届かない（単一プロセスデプロイが前提）。
"""

import logging

from app.domain.road_classes import (
    RoadClassGroup,
    check_group_change,
    check_group_deletable,
    replace_road_class_groups,
)
from app.infrastructure.road_class_repository import RoadClassRepository

logger = logging.getLogger("ridecompass.road_classes")


class RoadClassSyncError(RuntimeError):
    """群の表を読めない・アプリが受け入れない行がある。起動時の呼び出し元は捕まえず、起動を止める。

    群が1つも無いことは止めない——表を作ってから群を入れるまでの間も、群を読まない機能は動く。
    """


async def refresh_road_class_groups(repository: RoadClassRepository) -> None:
    """DBの群でプロセス内の群を差し替える。"""
    try:
        groups = await repository.list_all()
    except Exception as exc:  # 起動を止めるための専用の例外へ包む
        raise RoadClassSyncError(f"道の区分の群をDBから読めません error={exc!r}") from exc
    logger.info("道の区分の群をDBから読み込みました groups=%d", len(groups))
    replace_road_class_groups(groups)


class RoadClassAdminService:
    """群の管理APIのユースケース層。書き込みは1操作＝1トランザクションで確定し、直後にプロセス内へ反映する。

    書き込む操作は「読む→検査する→書く」の形なので、先頭で書き込みの鍵を取って全体を直列化する。
    """

    def __init__(self, repository: RoadClassRepository):
        self._repository = repository

    async def list_all(self) -> dict[str, RoadClassGroup]:
        return await self._repository.list_all()

    async def put(self, group: RoadClassGroup) -> None:
        """群を丸ごと書く。無ければ地図の層の並びの最後に足す。"""
        await self._repository.acquire_write_lock()
        existing = await self._repository.list_all()
        check_group_change(existing.get(group.group_key), group)
        sort_order = await self._repository.sort_order_of(group.group_key)
        if sort_order is None:
            sort_order = await self._repository.next_sort_order()
        await self._repository.put(group, sort_order)
        await self._repository.commit()
        await refresh_road_class_groups(self._repository)

    async def delete(self, group_key: str) -> None:
        await self._repository.acquire_write_lock()
        existing = await self._repository.list_all()
        if group_key not in existing:
            raise KeyError(group_key)
        check_group_deletable(existing[group_key])
        await self._repository.delete(group_key)
        await self._repository.commit()
        await refresh_road_class_groups(self._repository)
