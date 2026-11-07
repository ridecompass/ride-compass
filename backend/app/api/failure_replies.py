"""想定した失敗（上流から取れない・MSMを読めない・アメダスの観測値を出せない・DBに届かない）を、利用者へ返す状態と文にする。

失敗は途中の層で値に替えずに投げ、口では捕まえずに、ここがアプリ単位の例外の扱いで返す（口ごとに書くと、書き忘れた口だけが
500になる）。ルート生成のジョブの失敗の文も同じ`failure_reply`で決める。決め方に無い例外（実装の誤り等）は500のまま表へ出す。
上流の失敗の文には種類だけを載せる（例外の文はURLの問い合わせに座標が乗りうる）。DBの失敗の文には例外の文を載せない（接続先や
SQLが混じる）。どちらも中身は記録（`log_external_call`・アクセスログ）に残る。
"""

import json

import httpx
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from app.infrastructure.database import DB_UNAVAILABLE_ERRORS
from app.infrastructure.debug_log import error_type_label
from app.infrastructure.jma_amedas_store import AmedasUnavailableError
from app.infrastructure.msm_client import MsmUnavailableError
from app.infrastructure.simple_api_client import UnexpectedShapeError

#: 上流が返した本文がJSONでないとき（`httpx.Response.json`）も、上流の障害として数える。
UPSTREAM_ERRORS: tuple[type[Exception], ...] = (httpx.HTTPError, json.JSONDecodeError, UnexpectedShapeError)


def failure_reply(exc: BaseException) -> tuple[int, str] | None:
    """想定した失敗なら、利用者へ返す状態と文。決め方に無い例外ならNone。"""
    if isinstance(exc, UPSTREAM_ERRORS):
        return status.HTTP_502_BAD_GATEWAY, f"外部の配信元から取得できませんでした（{error_type_label(exc)}）"
    if isinstance(exc, MsmUnavailableError):
        return status.HTTP_503_SERVICE_UNAVAILABLE, f"気象の数値予報を読めません（{exc}）"
    if isinstance(exc, AmedasUnavailableError):
        return status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)
    if isinstance(exc, DB_UNAVAILABLE_ERRORS):
        return status.HTTP_503_SERVICE_UNAVAILABLE, "DBへのアクセスに失敗しました（DB接続と、テーブルが作られているかを確認してください）"
    return None


async def _reply(request: Request, exc: Exception) -> JSONResponse:
    del request
    reply = failure_reply(exc)
    if reply is None:
        raise exc
    status_code, detail = reply
    return JSONResponse(status_code=status_code, content={"detail": detail})


def install_failure_replies(app: FastAPI) -> None:
    for error_type in (*UPSTREAM_ERRORS, MsmUnavailableError, AmedasUnavailableError, *DB_UNAVAILABLE_ERRORS):
        app.add_exception_handler(error_type, _reply)
