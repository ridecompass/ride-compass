"""走りの記録の表（走り1回を1行）。端末が送った走りを GPX に直したものと、推したルート、生成の条件と予報を受けたまま持つ。

行は書いたあと変えない。同じ走り（端末が付けた id）が二度届いても、先の行のまま書かない（応答だけを失った端末が送り直すため）。
走りは送った利用者のもので、本人だけが読めて消せる（利用者の無い行は、ログインを入れる前に受けた走り）。
走りの一覧に出す走り始めの時刻・距離・かかった時間は、受けたときに1回だけ求めて列に書き、一覧は GPX を読まない（ログインを入れる前の行は空）。
"""

from datetime import datetime
from typing import cast
from uuid import UUID

import asyncpg
from sqlalchemy import DateTime, ForeignKey, Integer, Row, Text, delete, func, select
from sqlalchemy.dialects.postgresql import JSONB, insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.domain.region import MAX_MERCATOR_LATITUDE
from app.domain.ride_track import RideSummary, RideUpload
from app.infrastructure.dem_elevation import fill_elevations, products_in_priority
from app.infrastructure.orm_base import Base


class RideTrackRow(Base):
    __tablename__ = "ride_tracks"

    ride_id: Mapped[UUID] = mapped_column(primary_key=True)
    gpx: Mapped[str] = mapped_column(Text, nullable=False)
    routes: Mapped[dict] = mapped_column(JSONB, nullable=False)
    #: 生成の条件と予報（`{"conditions": …, "forecasts": […]}`）。
    context: Mapped[dict] = mapped_column(JSONB, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    account_id: Mapped[UUID | None] = mapped_column(ForeignKey("accounts.id"), index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    distance_m: Mapped[int | None] = mapped_column(Integer)
    duration_s: Mapped[int | None] = mapped_column(Integer)


#: 地点（`$1`・`$2`は緯度・経度の配列）を渡した順の番号（`vid`）つきで。地図の投影（Web Mercator）の範囲の外の点はタイルの
#: 番地を出せない（端末が誤った位置を送りうる）ので、入れずに値の無い点にする。
_GROUND_POINTS_SQL = f"""
CREATE TEMP TABLE _ground_point ON COMMIT DROP AS
SELECT i AS vid, lat, lon FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS t(lat, lon, i)
WHERE abs(lat) < {MAX_MERCATOR_LATITUDE}
"""


async def ground_elevations_m(session: AsyncSession, lat_lon: list[tuple[float, float]]) -> list[float | None]:
    """地点（緯度, 経度）ごとの地形の標高（m。取り込んだ範囲の外・値の無い画素はNone）を、渡した順に。画素を引く関数
    （`infrastructure/dem_elevation.py: fill_elevations`）は asyncpg の接続を受けるので、セッションの下の接続で流す。"""
    if not lat_lon:
        return []
    conn = cast(asyncpg.Connection, (await (await session.connection()).get_raw_connection()).driver_connection)
    async with conn.transaction():
        await conn.execute("DROP TABLE IF EXISTS _ground_point")
        await conn.execute(_GROUND_POINTS_SQL, [lat for lat, _ in lat_lon], [lon for _, lon in lat_lon])
        await fill_elevations(conn, "_ground_point", "_ground_elev", await products_in_priority(conn))
        elevations = {r["vid"]: r["elev"] for r in await conn.fetch("SELECT vid, elev FROM _ground_elev")}
    return [elevations.get(i) for i in range(1, len(lat_lon) + 1)]


async def ride_track_exists(session: AsyncSession, ride_id: UUID) -> bool:
    return await session.get(RideTrackRow, ride_id) is not None


async def insert_ride_track(session: AsyncSession, upload: RideUpload, *, gpx: str, summary: RideSummary,
                            account_id: UUID) -> None:
    """走り1回の行を書く。同じ id の行が既にあれば書かない。"""
    dumped = upload.model_dump(mode="json", include={"routes", "conditions", "forecasts"})
    await session.execute(
        pg_insert(RideTrackRow)
        .values(
            ride_id=upload.id,
            account_id=account_id,
            gpx=gpx,
            routes=dumped["routes"],
            context={"conditions": dumped["conditions"], "forecasts": dumped["forecasts"]},
            started_at=summary.started_at,
            distance_m=summary.distance_m,
            duration_s=summary.duration_s,
        )
        .on_conflict_do_nothing(index_elements=["ride_id"])
    )


_SUMMARY_COLUMNS = (RideTrackRow.ride_id.label("id"), RideTrackRow.started_at, RideTrackRow.distance_m, RideTrackRow.duration_s)


def _summary(row: Row) -> RideSummary:
    return RideSummary.model_validate({name: row._mapping[name] for name in RideSummary.model_fields})


async def account_ride_summaries(session: AsyncSession, account_id: UUID) -> list[RideSummary]:
    """その利用者の走りを、走り始めの新しい順に（GPX は読まない）。"""
    rows = await session.execute(
        select(*_SUMMARY_COLUMNS).where(RideTrackRow.account_id == account_id).order_by(RideTrackRow.started_at.desc())
    )
    return [_summary(row) for row in rows]


async def account_ride(session: AsyncSession, account_id: UUID, ride_id: UUID) -> tuple[RideSummary, str] | None:
    """その利用者の走り1件と GPX。無い・ほかの人の走りならNone。"""
    row = (await session.execute(
        select(*_SUMMARY_COLUMNS, RideTrackRow.gpx).where(RideTrackRow.ride_id == ride_id, RideTrackRow.account_id == account_id)
    )).one_or_none()
    return None if row is None else (_summary(row), row.gpx)


async def delete_account_ride(session: AsyncSession, account_id: UUID, ride_id: UUID) -> bool:
    """その利用者の走り1件を消す。無い・ほかの人の走りなら何もせず偽。"""
    result = await session.execute(
        delete(RideTrackRow).where(RideTrackRow.ride_id == ride_id, RideTrackRow.account_id == account_id)
        .returning(RideTrackRow.ride_id)
    )
    return result.first() is not None
