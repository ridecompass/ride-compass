"""走りの記録を受ける口（`POST /api/rides`）。

本文は gzip で縮めて受けられる（`Content-Encoding: gzip`。本番の nginx の要求の大きさの上限、既定の 1MB に長い走りも収めるため）。
縮めた本文は、FastAPI の文書の例（Custom Request and APIRoute class の`GzipRequest`）と同じ形で、本文を読むときに戻す。例の
`gzip.decompress`は戻す大きさに上限を持たないので、`zlib`で上限を付けて戻す。
"""

import zlib
from collections.abc import Callable

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.routing import APIRoute

from app.api.dependencies import TileSessions
from app.config import settings
from app.domain.ride_track import RideUpload
from app.infrastructure.ride_track_models import store_ride_track

#: 戻した本文の大きさの上限。小さく縮めて巨大に膨らむ本文でメモリを食わせないよう、1秒1点で長く走った走りに推したルートと
#: 予報を足しても届かない大きさで切る（点1つは約50バイトで、100時間分でも約18MB）。
MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024


class _GzipRequest(Request):
    async def body(self) -> bytes:
        if not hasattr(self, "_body"):
            body = await super().body()
            if "gzip" in self.headers.getlist("Content-Encoding"):
                inflater = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
                body = inflater.decompress(body, MAX_DECOMPRESSED_BYTES)
                if inflater.unconsumed_tail:
                    raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="走りの記録が大きすぎます")
            self._body = body
        return self._body


class _GzipRoute(APIRoute):
    def get_route_handler(self) -> Callable:
        original_route_handler = super().get_route_handler()

        async def custom_route_handler(request: Request) -> Response:
            return await original_route_handler(_GzipRequest(request.scope, request.receive))

        return custom_route_handler


router = APIRouter(prefix="/api/rides", tags=["rides"], route_class=_GzipRoute)


@router.post("", status_code=status.HTTP_204_NO_CONTENT)
async def receive_ride(upload: RideUpload, tile_sessions: TileSessions) -> None:
    """走り1回を書く。同じ走りが二度届いても先の行のまま、書けたものとして返す（端末はこれを見て手元の記録を消す）。"""
    async with tile_sessions() as session:
        await store_ride_track(session, upload, server_commit=settings.git_commit)
        await session.commit()
