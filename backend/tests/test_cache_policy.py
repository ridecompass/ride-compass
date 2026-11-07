"""`api/cache_policy.py`（Cache-Controlの一元管理）のテスト。

対応表の網羅性を機械的に検証することで、新しいエンドポイントを追加したときの
「ポリシーの決め忘れ」と、リファクタで消えたパスの「死んだエントリ」の両方を落とす。

ここで見ないもの: 表の各行の秒数（宣言の書き写しになる）、`Cache-Control`の書式 → `test_jma_tile_routes.py`
"""

from fastapi.routing import APIRoute

from app.api.cache_policy import ROUTE_POLICIES, policy_for_path
from app.main import app


def _api_routes():
    return [route for route in app.routes if isinstance(route, APIRoute)]


def test_every_route_has_a_cache_policy():
    missing = [route.path for route in _api_routes() if policy_for_path(route.path) is None]
    assert missing == [], f"cache_policy.pyの対応表に無いルート: {missing}"


def test_every_policy_entry_matches_a_real_route():
    paths = [route.path for route in _api_routes()]
    dead = [prefix for prefix, _ in ROUTE_POLICIES if not any(path.startswith(prefix) for path in paths)]
    assert dead == [], f"どの実ルートにも一致しない対応表のエントリ: {dead}"


def test_policy_for_path_returns_none_for_unknown_path():
    assert policy_for_path("/api/does-not-exist") is None
