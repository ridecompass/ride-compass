"""上流（外部の配信元）から取れなかった例外を、どの口でも502で返すアプリ単位の例外の扱い。

上流の取得は失敗を値に替えずに投げ（`infrastructure/http_client.py: fetch_upstream`・
`infrastructure/simple_api_client.py: cached_fetch`）、ここが口の1か所で502にする。文には失敗の種類だけを載せる
（例外の文はURLの問い合わせに座標が乗りうるので出さない。記録は`log_external_call`が残す）。
"""

import json

import httpx
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from app.infrastructure.debug_log import error_type_label
from app.infrastructure.jma_amedas_store import AmedasUnavailableError
from app.infrastructure.msm_client import MsmUnavailableError
from app.infrastructure.simple_api_client import UnexpectedShapeError

#: 上流が返した本文がJSONでないとき（`httpx.Response.json`）も、上流の障害として数える。
UPSTREAM_ERRORS: tuple[type[Exception], ...] = (httpx.HTTPError, json.JSONDecodeError, UnexpectedShapeError)


async def upstream_unavailable_handler(request: Request, exc: Exception) -> JSONResponse:
    del request
    return JSONResponse(
        status_code=status.HTTP_502_BAD_GATEWAY,
        content={"detail": f"外部の配信元から取得できませんでした（{error_type_label(exc)}）"},
    )


async def msm_unavailable_handler(request: Request, exc: Exception) -> JSONResponse:
    """気象の数値予報（MSM。上流から同期して置いたもの）を読めない。理由（未同期・予報が今に追いついていない等）を載せる。"""
    del request
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"detail": f"気象の数値予報を読めません（{exc}）"}
    )


async def amedas_unavailable_handler(request: Request, exc: Exception) -> JSONResponse:
    """アメダスの観測値を出せない。理由（置き場を読めない・観測値が無い）を載せる。"""
    del request
    return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"detail": str(exc)})


def install_upstream_error_handler(app: FastAPI) -> None:
    for error_type in UPSTREAM_ERRORS:
        app.add_exception_handler(error_type, upstream_unavailable_handler)
    app.add_exception_handler(MsmUnavailableError, msm_unavailable_handler)
    app.add_exception_handler(AmedasUnavailableError, amedas_unavailable_handler)
