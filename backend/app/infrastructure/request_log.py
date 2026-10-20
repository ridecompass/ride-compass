"""リクエスト1件=1行のHTTPアクセスサマリログと、ログ1行の書式(方針は .claude/rules/logging.md)。

リクエストIDの引き継ぎ・発行・応答ヘッダへの付与は`asgi_correlation_id.CorrelationIdMiddleware`
（`main.py`で登録）が持ち、ここはそのIDをログ行と500応答へ載せる側だけを持つ。
"""

import logging
from collections.abc import Awaitable, Callable
from datetime import datetime

from asgi_correlation_id import CorrelationIdFilter, correlation_id
from fastapi import Request, Response
from fastapi.responses import PlainTextResponse

from app.domain.stopwatch import elapsed_ms, start_timer
from app.domain.time_zone import JST

access_logger = logging.getLogger("ridecompass.access")


#: ログ1行の書式。`%(correlation_id)s`は`format_log_lines`が付けるフィルタが入れる。
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s [req:%(correlation_id)s]: %(message)s"


class JstLogFormatter(logging.Formatter):
    """時刻をJSTで、**オフセット付き**で出すフォーマッタ。

    コンテナの`TZ`ではなく整形する側を変えるのは、`TZ`が素の`datetime.now()`の意味まで
    変えてしまうため（スケジューラ・DBへ書く時刻へ波及する）。
    """

    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:
        at = datetime.fromtimestamp(record.created, JST)
        return f"{at.strftime('%Y-%m-%d %H:%M:%S')},{int(record.msecs):03d}{at.strftime('%z')}"


def format_log_lines(handler: logging.Handler) -> None:
    """ハンドラへログ1行の書式（JSTの時刻・リクエストID）を付ける。

    標準出力（main.py）と管理画面のリングバッファ（debug_control.py）が同じ行を出すよう、
    書式とリクエストIDの入れ方はここだけに置く。リクエストの外で出た行のIDは`-`になる。
    """
    handler.addFilter(CorrelationIdFilter(default_value="-"))
    handler.setFormatter(JstLogFormatter(LOG_FORMAT))


async def unhandled_exception_handler(request: Request, exc: Exception) -> Response:
    """FastAPIの`Exception`ハンドラとして登録する(main.py: `app.add_exception_handler`)。

    500応答は本来Starletteの`ServerErrorMiddleware`（リクエストIDのミドルウェアの外側）が
    作るため、そこにはX-Request-IDが付かない。FastAPIのExceptionハンドラはその中で
    呼ばれるので、ここで同じ形のプレーンテキスト応答を組み立ててヘッダを載せる。
    """
    del request, exc  # スタックトレースはrequest_log_middleware側で既にERRORログ済み
    return PlainTextResponse(
        "Internal Server Error", status_code=500, headers={"X-Request-ID": correlation_id.get() or "-"}
    )


def access_level(path: str, status_code: int, tile_path_prefixes: tuple[str, ...]) -> int:
    """アクセスログの1行のレベル。`tile_path_prefixes`は地図タイルの経路（GETだけで、通常操作でも毎分数百件になる）。"""
    if status_code >= 500:
        return logging.ERROR
    if status_code == 429:
        # 429はrecord_rate_limit_rejection(debug_log.py)が抑制付きWARNINGで別途記録する
        # ため、アクセスログ側で重ねてWARNINGにしない。
        return logging.DEBUG
    # タイルの成功と「そのタイルは無い」404はログを埋めないようDEBUGへ落とす。疎な格子・整備区域の外・
    # 配信前のタイルは404が正常系として視界の分だけ並ぶ。
    if path.startswith(tile_path_prefixes) and (status_code < 400 or status_code == 404):
        return logging.DEBUG
    if status_code >= 400:
        return logging.WARNING
    return logging.INFO


def request_log_middleware(tile_path_prefixes: tuple[str, ...]) -> Callable[..., Awaitable[Response]]:
    """1リクエスト=1行のアクセスログを出すHTTPミドルウェア。`tile_path_prefixes`は`access_level`へ渡す。"""

    async def log_access(request: Request, call_next) -> Response:
        started = start_timer()
        client = request.client.host if request.client else "unknown"
        try:
            response = await call_next(request)
        except Exception:
            access_logger.exception(
                "%s %s -> unhandled exception after %dms client=%s",
                request.method,
                request.url.path,
                elapsed_ms(started),
                client,
            )
            raise
        access_logger.log(
            access_level(request.url.path, response.status_code, tile_path_prefixes),
            "%s %s -> %d in %dms client=%s",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms(started),
            client,
        )
        return response

    return log_access
