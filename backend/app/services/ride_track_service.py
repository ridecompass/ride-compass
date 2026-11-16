"""走りの記録の書き込み（`POST /api/rides`のサービス層）。取引の境界はここが持つ（構造仕様7）。"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.ride_track import RideUpload
from app.infrastructure.ride_gpx import ride_gpx
from app.infrastructure.ride_track_models import ground_elevations_m, insert_ride_track, ride_track_exists


class RideTrackService:
    """`session`は1本の接続を長く持つ工場のもの（地形の標高を引く間、接続を持ち続ける。`api/dependencies.py: get_ride_track_service`）。"""

    def __init__(self, session: AsyncSession, *, server_commit: str | None):
        self._session = session
        self._server_commit = server_commit

    async def store(self, upload: RideUpload) -> None:
        """走り1回を1行書く（GPX の先頭の情報に、受けたサーバーの版と、走った地点ごとの地形の標高を添える）。同じ id の行が
        既にあれば書かない。"""
        if await ride_track_exists(self._session, upload.id):  # 送り直し。地形の標高を引き直さない
            return
        ground = await ground_elevations_m(self._session, [(lat / 1e6, lon / 1e6) for _, lat, lon, *_ in upload.points])
        gpx = ride_gpx(upload, server_commit=self._server_commit, ground_elevation_m=ground)
        await insert_ride_track(self._session, upload, gpx=gpx)
        await self._session.commit()
