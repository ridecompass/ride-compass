"""管理画面API（`require_admin_basic_auth`）のテストが共有するBasic認証の材料。

認証情報そのものは`admin_credentials`フィクスチャ（conftest.py）が`settings`へ入れる。
ここはヘッダーの組み立てと、認証を掛ける管理APIの経路の母集団を持つ。
"""

import base64

from fastapi import FastAPI
from fastapi.routing import APIRoute, RouteContext, iter_route_contexts

from app.api.admin_paths import ADMIN_PATH_PREFIX


ADMIN_USERNAME = "admin-user"
ADMIN_PASSWORD = "secret-password"


def basic_auth_header(username: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()


AUTH_HEADERS = {"Authorization": basic_auth_header(ADMIN_USERNAME, ADMIN_PASSWORD)}


def admin_routes(app: FastAPI) -> list[RouteContext]:
    """`app`の経路のうち、管理APIの接頭辞の下にあるもの（含めたルーターの接頭辞と依存を畳んだ実効の経路）。"""
    return [
        route
        for route in iter_route_contexts(app.routes)
        if isinstance(route.route, APIRoute) and route.path is not None and route.path.startswith(ADMIN_PATH_PREFIX)
    ]
