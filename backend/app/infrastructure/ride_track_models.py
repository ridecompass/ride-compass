"""走りの記録の表（走り1回を1行）。端末が送った走りを GPX に直したものと、推したルート、生成の条件と予報を受けたまま持つ。

行は書いたあと変えない。同じ走り（端末が付けた id）が二度届いても、先の行のまま書かない（応答だけを失った端末が送り直すため）。
"""

from datetime import datetime
from typing import cast
from uuid import UUID

import asyncpg
from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import JSONB, insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.domain.region import MAX_MERCATOR_LATITUDE
from app.domain.ride_track import RideUpload
from app.infrastructure.dem_elevation import fill_elevations, products_in_priority
from app.infrastructure.orm_base import Base
from app.infrastructure.ride_gpx import ride_gpx


class RideTrackRow(Base):
    __tablename__ = "ride_tracks"

    ride_id: Mapped[UUID] = mapped_column(primary_key=True)
    gpx: Mapped[str] = mapped_column(Text, nullable=False)
    routes: Mapped[dict] = mapped_column(JSONB, nullable=False)
    #: 生成の条件と予報（`{"conditions": …, "forecasts": […]}`）。
    context: Mapped[dict] = mapped_column(JSONB, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


#: 地点（`$1`・`$2`は緯度・経度の配列）を渡した順の番号（`vid`）つきで。地図の投影（Web Mercator）の範囲の外の点はタイルの
#: 番地を出せない（端末が誤った位置を送りうる）ので、入れずに値の無い点にする。
_GROUND_POINTS_SQL = f"""
CREATE TEMP TABLE _ground_point ON COMMIT DROP AS
SELECT i AS vid, lat, lon FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS t(lat, lon, i)
WHERE abs(lat) < {MAX_MERCATOR_LATITUDE}
"""


async def _ground_elevations_m(session: AsyncSession, lat_lon: list[tuple[float, float]]) -> list[float | None]:
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


async def store_ride_track(session: AsyncSession, upload: RideUpload, *, server_commit: str | None) -> None:
    """走り1回を1行書く（GPX の先頭の情報に、受けたサーバーの版と、走った地点ごとの地形の標高を添える）。同じ id の行が既にあれば
    書かない。取引の区切り（`commit`）は呼び出し元が持つ。"""
    if await session.get(RideTrackRow, upload.id) is not None:  # 送り直し。地形の標高を引き直さない
        return
    ground = await _ground_elevations_m(session, [(lat / 1e6, lon / 1e6) for _, lat, lon, *_ in upload.points])
    dumped = upload.model_dump(mode="json", include={"routes", "conditions", "forecasts"})
    await session.execute(
        pg_insert(RideTrackRow)
        .values(
            ride_id=upload.id,
            gpx=ride_gpx(upload, server_commit=server_commit, ground_elevation_m=ground),
            routes=dumped["routes"],
            context={"conditions": dumped["conditions"], "forecasts": dumped["forecasts"]},
        )
        .on_conflict_do_nothing(index_elements=["ride_id"])
    )
