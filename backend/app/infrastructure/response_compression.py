"""応答のgzip圧縮（content-typeで対象を絞ったGZipMiddleware）。

StarletteのGZipMiddlewareはcontent-typeを見ずに全応答を圧縮し、既に圧縮済みのラスタタイルにもCPUを使うため、
対象のcontent-typeの応答だけを圧縮して、それ以外は素通しする。
"""

from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipMiddleware, GZipResponder
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.infrastructure.media_types import MVT_CONTENT_TYPE

# 圧縮対象のcontent-type（パラメータ部を除いた小文字比較）。`text/`で始まるものは常に対象。
_COMPRESSIBLE_CONTENT_TYPES = frozenset(
    {
        "application/json",
        MVT_CONTENT_TYPE,
        "application/x-protobuf",
        "application/javascript",
    }
)
DEFAULT_MINIMUM_SIZE = 1000
_COMPRESS_LEVEL = 3


def _is_compressible_content_type(content_type: str | None) -> bool:
    if not content_type:
        return False
    media_type = content_type.split(";", 1)[0].strip().lower()
    return media_type.startswith("text/") or media_type in _COMPRESSIBLE_CONTENT_TYPES


class _ContentTypeGZipResponder(GZipResponder):
    """応答ヘッダのcontent-typeが圧縮対象外なら、以後のメッセージを無加工で送る。"""

    def __init__(self, app: ASGIApp, minimum_size: int, compresslevel: int) -> None:
        super().__init__(app, minimum_size, compresslevel=compresslevel)
        self._passthrough = False

    async def send_with_gzip(self, message: Message) -> None:
        if message["type"] == "http.response.start":
            headers = Headers(raw=message["headers"])
            self._passthrough = not _is_compressible_content_type(headers.get("content-type"))
        if self._passthrough:
            await self.send(message)
            return
        await super().send_with_gzip(message)


class ContentTypeGZipMiddleware(GZipMiddleware):
    """`Accept-Encoding: gzip`のリクエストに対し、圧縮対象content-typeの応答だけをgzipする。"""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app, minimum_size=DEFAULT_MINIMUM_SIZE, compresslevel=_COMPRESS_LEVEL)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and "gzip" in Headers(scope=scope).get("Accept-Encoding", ""):
            responder = _ContentTypeGZipResponder(self.app, self.minimum_size, compresslevel=self.compresslevel)
            await responder(scope, receive, send)
            return
        await self.app(scope, receive, send)
