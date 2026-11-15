"""走りの記録の表（走り1回を1行）。端末が送った走りを GPX に直したものと、推したルート、生成の条件と予報を受けたまま持つ。

行は書いたあと変えない。同じ走り（端末が付けた id）が二度届いても、先の行のまま書かない（応答だけを失った端末が送り直すため）。
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import JSONB, insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.domain.ride_track import RideUpload, ride_gpx
from app.infrastructure.orm_base import Base


class RideTrackRow(Base):
    __tablename__ = "ride_tracks"

    ride_id: Mapped[UUID] = mapped_column(primary_key=True)
    gpx: Mapped[str] = mapped_column(Text, nullable=False)
    routes: Mapped[dict] = mapped_column(JSONB, nullable=False)
    #: 生成の条件と予報（`{"conditions": …, "forecasts": […]}`）。
    context: Mapped[dict] = mapped_column(JSONB, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


async def store_ride_track(session: AsyncSession, upload: RideUpload, *, server_commit: str | None) -> None:
    """走り1回を1行書く（GPX の先頭の情報に、受けたサーバーの版を添える）。同じ id の行が既にあれば書かない。取引の区切り（`commit`）は呼び出し元が持つ。"""
    dumped = upload.model_dump(mode="json", include={"routes", "conditions", "forecasts"})
    await session.execute(
        pg_insert(RideTrackRow)
        .values(
            ride_id=upload.id,
            gpx=ride_gpx(upload, server_commit=server_commit),
            routes=dumped["routes"],
            context={"conditions": dumped["conditions"], "forecasts": dumped["forecasts"]},
        )
        .on_conflict_do_nothing(index_elements=["ride_id"])
    )
