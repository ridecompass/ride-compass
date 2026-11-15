"""走りの記録を受ける口（`POST /api/rides`）。

書けるのは、書くための鍵（`settings.ride_track_key`）を端末に入れた人だけ。鍵は管理画面の資格情報と別にし、走るたびに
ログインさせない。鍵が未設定（既定の空文字）の環境では常に断る——うっかり誰でも書ける形で出さない。

本文は gzip で縮めて受けられる（`Content-Encoding: gzip`。本番の nginx の要求の大きさの上限、既定の 1MB に長い走りも収めるため）。
縮めた本文は、FastAPI の文書の例（Custom Request and APIRoute class の`GzipRequest`）と同じ形で、本文を読むときに戻す。例の
`gzip.decompress`は戻す大きさに上限を持たないので、`zlib`で上限を付けて戻す。
"""

import secrets
import zlib
from collections.abc import Callable

from fastapi import APIRouter, Header, HTTPException, Request, Response, status
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


class _RideRoute(APIRoute):
    """鍵を照らしてから本文を読む。FastAPI は本文の読みと型の検証をハンドラより前に済ませるので、鍵をハンドラで照らすと、
    鍵を知らない要求にも本文を戻して検証させ（CPU とメモリを使わせ）、形の誤りを 422 で教えてしまう。"""

    def get_route_handler(self) -> Callable:
        original_route_handler = super().get_route_handler()

        async def custom_route_handler(request: Request) -> Response:
            sent = request.headers.get("X-Ride-Key")
            # 文字列のまま比べると、ASCII でない文字を含む鍵で`compare_digest`が投げるので、バイト列で比べる。
            if not (
                settings.ride_track_key
                and sent is not None
                and secrets.compare_digest(sent.encode(), settings.ride_track_key.encode())
            ):
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="走りの記録の鍵が合いません")
            return await original_route_handler(_GzipRequest(request.scope, request.receive))

        return custom_route_handler


router = APIRouter(prefix="/api/rides", tags=["rides"], route_class=_RideRoute)


@router.post("", status_code=status.HTTP_204_NO_CONTENT)
async def receive_ride(
    upload: RideUpload,
    tile_sessions: TileSessions,
    # 鍵は`_RideRoute`が本文より前に照らす。ここで受けるのは、送る見出しを API の型に出すため。
    ride_key: str | None = Header(default=None, alias="X-Ride-Key"),
) -> None:
    """走り1回を書く。同じ走りが二度届いても先の行のまま、書けたものとして返す（端末はこれを見て手元の記録を消す）。"""
    async with tile_sessions() as session:
        await store_ride_track(session, upload, server_commit=settings.git_commit)
        await session.commit()
