"""走りの記録の表（走り1回を1行）。端末が送った走りを GPX に直したものと、推したルート、生成の条件と予報を受けたまま持つ。

行は書いたあと変えない。同じ走り（端末が付けた id）が二度届いても、先の行のまま書かない（応答だけを失った端末が送り直すため）。
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.domain.gsi_tiles import PRODUCT_PRIORITY
from app.domain.region import MAX_MERCATOR_LATITUDE, tile_position_sql
from app.domain.ride_track import RideUpload
from app.infrastructure.orm_base import Base
from app.infrastructure.ride_gpx import ride_gpx
from app.infrastructure.source_models import (
    DEM_TILES_SQL,
    INGESTED_DEM_PRODUCTS_SQL,
    dem_pixel_value_sql,
    dem_tile_pixels_sql,
)


class RideTrackRow(Base):
    __tablename__ = "ride_tracks"

    ride_id: Mapped[UUID] = mapped_column(primary_key=True)
    gpx: Mapped[str] = mapped_column(Text, nullable=False)
    routes: Mapped[dict] = mapped_column(JSONB, nullable=False)
    #: 生成の条件と予報（`{"conditions": …, "forecasts": […]}`）。
    context: Mapped[dict] = mapped_column(JSONB, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


_GROUND_X, _GROUND_Y = tile_position_sql("p.lon", "p.lat", "pr.z")
#: 地点ごとの地形の標高（m。値が無ければNULL）を、渡した順に。画素は道の標高の派生と同じく、取り込んだ標高タイルを製品の並び
#: （`:products`）の順に見て、値のある最初の製品を採る。製品はそれぞれ取り込んだズームで番地を出す。地点はタイルごとに束ね、
#: タイルを1回だけ展開して引く（`infrastructure/source_models.py: dem_tile_pixels_sql`）。
_GROUND_ELEVATIONS_SQL = text(f"""
WITH p AS (
  SELECT i, lat, lon FROM unnest(CAST(:lats AS float8[]), CAST(:lons AS float8[])) WITH ORDINALITY AS t(lat, lon, i)),
pr AS (
  SELECT r.product, r.rank, d.zoom AS z
  FROM unnest(CAST(:products AS text[])) WITH ORDINALITY AS r(product, rank)
  JOIN ({INGESTED_DEM_PRODUCTS_SQL}) d ON d.product = r.product),
a AS (
  SELECT p.i, pr.product, pr.rank, f.fx, f.fy, floor(f.fx)::int AS tx, floor(f.fy)::int AS ty
  FROM p CROSS JOIN pr CROSS JOIN LATERAL (SELECT {_GROUND_X} AS fx, {_GROUND_Y} AS fy) f
  -- 地図の投影（Web Mercator）の範囲の外の点はタイルの番地を出せない（端末が誤った位置を送りうる）。
  WHERE abs(p.lat) < {MAX_MERCATOR_LATITUDE}),
k AS (
  SELECT a.product, a.rank, a.tx, a.ty, array_agg(a.i) AS i, array_agg(a.fx) AS fx, array_agg(a.fy) AS fy
  FROM a GROUP BY a.product, a.rank, a.tx, a.ty),
v AS (
  SELECT q.i, k.rank, {dem_pixel_value_sql("g", "q.fx", "q.fy", "k.tx", "k.ty")} AS elev
  FROM k JOIN {DEM_TILES_SQL} t
    ON t.attrs->>'product' = k.product AND (t.attrs->>'x')::int = k.tx AND (t.attrs->>'y')::int = k.ty
  {dem_tile_pixels_sql("t", "g")}
  CROSS JOIN LATERAL unnest(k.i, k.fx, k.fy) AS q(i, fx, fy))
SELECT (array_agg(v.elev ORDER BY v.rank) FILTER (WHERE v.elev IS NOT NULL))[1] AS elev
FROM p LEFT JOIN v ON v.i = p.i
GROUP BY p.i ORDER BY p.i
""")


async def _ground_elevations_m(session: AsyncSession, lat_lon: list[tuple[float, float]]) -> list[float | None]:
    """地点（緯度, 経度）ごとの地形の標高（m。取り込んだ範囲の外・値の無い画素はNone）を、渡した順に。"""
    if not lat_lon:
        return []
    rows = await session.execute(_GROUND_ELEVATIONS_SQL, {
        "lats": [lat for lat, _ in lat_lon], "lons": [lon for _, lon in lat_lon], "products": list(PRODUCT_PRIORITY)})
    return [None if row.elev is None else float(row.elev) for row in rows]


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
