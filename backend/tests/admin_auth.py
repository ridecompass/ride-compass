"""管理画面API（`require_admin_basic_auth`）のテストが共有するBasic認証の材料。

認証情報そのものは`admin_credentials`フィクスチャ（conftest.py）が`settings`へ入れる。
ここはヘッダーの組み立てと、認証を掛ける管理APIの経路の母集団を持つ。
"""

import base64

from fastapi import FastAPI
from fastapi.routing import APIRoute

from app.api.admin_db_errors import ADMIN_PATH_PREFIX

ADMIN_USERNAME = "admin-user"
ADMIN_PASSWORD = "secret-password"


def basic_auth_header(username: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()


AUTH_HEADERS = {"Authorization": basic_auth_header(ADMIN_USERNAME, ADMIN_PASSWORD)}


def admin_routes(app: FastAPI) -> list[APIRoute]:
    """`app`の経路のうち、管理APIの接頭辞の下にあるもの。"""
    return [route for route in app.routes if isinstance(route, APIRoute) and route.path.startswith(ADMIN_PATH_PREFIX)]
