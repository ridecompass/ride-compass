"""道の区分の群と行（road_class_groups・road_class_rows）のPostGIS永続化層。

書き込みメソッドはcommitしない（呼び出し側の`services/road_class_service.py: RoadClassAdminService`が
操作のまとまりごとに`commit()`を呼んで確定する）。
"""

from datetime import datetime, timezone

from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.road_classes import RoadClassGroup, RoadClassRow
from app.infrastructure.road_class_models import RoadClassGroupRow, RoadClassRowRow

# 書き込みは「読む→検査する→書く」の形なので、プロセスをまたいで直列化する（軸定義の書き込みの鍵とは別の固定値）。
_WRITE_LOCK_KEY = 0x524F4144434C5353

#: 群・行の欄のうち、行の列の名前が違うもの（ほかの欄は同じ名前の列に入る）。
_COLUMN_OF_ROW_FIELD = {"key": "row_key"}
_GROUP_FIELDS = [name for name in RoadClassGroup.model_fields if name != "rows"]


class RoadClassRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def acquire_write_lock(self) -> None:
        """書き込みの操作の冒頭で呼ぶ。トランザクションの間だけ効くadvisory lockで、commit・rollbackで外れる。"""
        await self._session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _WRITE_LOCK_KEY})

    async def list_all(self) -> dict[str, RoadClassGroup]:
        """群の鍵→群。群は地図の層の並び、行は群の中の判定の順。"""
        groups = (
            (await self._session.execute(select(RoadClassGroupRow).order_by(RoadClassGroupRow.sort_order)))
            .scalars().all()
        )
        rows = (
            (await self._session.execute(
                select(RoadClassRowRow).order_by(RoadClassRowRow.group_key, RoadClassRowRow.sort_order)))
            .scalars().all()
        )
        rows_of: dict[str, list[dict]] = {}
        for row in rows:
            rows_of.setdefault(row.group_key, []).append(
                {name: getattr(row, _COLUMN_OF_ROW_FIELD.get(name, name)) for name in RoadClassRow.model_fields})
        return {
            group.group_key: RoadClassGroup.model_validate(
                {**{name: getattr(group, name) for name in _GROUP_FIELDS}, "rows": rows_of.get(group.group_key, [])})
            for group in groups
        }

    async def sort_order_of(self, group_key: str) -> int | None:
        return (await self._session.execute(
            select(RoadClassGroupRow.sort_order).where(RoadClassGroupRow.group_key == group_key))).scalar_one_or_none()

    async def next_sort_order(self) -> int:
        current = (await self._session.execute(select(RoadClassGroupRow.sort_order).order_by(
            RoadClassGroupRow.sort_order.desc()).limit(1))).scalar_one_or_none()
        return 0 if current is None else current + 1

    async def put(self, group: RoadClassGroup, sort_order: int) -> None:
        """群を丸ごと書く（行は書いた群の行だけになる）。"""
        dumped = group.model_dump(mode="json")
        values = {
            **{name: dumped[name] for name in _GROUP_FIELDS},
            "sort_order": sort_order,
            "updated_at": datetime.now(timezone.utc),
        }
        stmt = pg_insert(RoadClassGroupRow).values(**values)
        await self._session.execute(stmt.on_conflict_do_update(
            index_elements=[RoadClassGroupRow.group_key],
            set_={name: stmt.excluded[name] for name in values if name != "group_key"},
        ))
        await self._session.execute(delete(RoadClassRowRow).where(RoadClassRowRow.group_key == group.group_key))
        await self._session.execute(pg_insert(RoadClassRowRow).values([
            {
                **{_COLUMN_OF_ROW_FIELD.get(name, name): value for name, value in row.items()},
                "group_key": group.group_key,
                "sort_order": index,
            }
            for index, row in enumerate(dumped["rows"])
        ]))

    async def delete(self, group_key: str) -> bool:
        """群とその行を消す。群が無ければFalse。"""
        result = await self._session.execute(
            delete(RoadClassGroupRow).where(RoadClassGroupRow.group_key == group_key)
            .returning(RoadClassGroupRow.group_key))
        return result.first() is not None

    async def commit(self) -> None:
        await self._session.commit()
