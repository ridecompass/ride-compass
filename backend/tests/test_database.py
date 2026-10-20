"""`infrastructure/database.py`——PostGISへの接続の口（2系統のセッションファクトリ）と、DB障害として捕まえる例外。

エンジンはプロセス大域に1つずつ作られるので、テストごとに閉じる口（`dispose_engines`）で作る前の状態に戻してから始め、同じ口で閉じる。
接続先は`config.py: settings`の`database_url`を差し替えて与える（DBへは届かない宛先にする）。

ここで見ないもの:
- どのリクエストがどちらの系統を使うか → `api/dependencies.py`を通る各ルーターのテスト
- DB障害の例外を受けて空・503へ倒すこと → 倒す側のテスト（例: `test_gradient_way_service.py`・`test_region_service.py`）
- 実行中の待ちの上限（`command_timeout`）。上限は通常の系統で20秒あり、届かせるにはその時間だけ待つ
"""

import pytest
from sqlalchemy import text

from app.config import settings
from app.infrastructure import database

# 何も聞いていないポート。接続は張る段階ですぐに断られる。
UNREACHABLE_DATABASE_URL = "postgresql+asyncpg://user:password@127.0.0.1:1/unreachable"

FACTORIES = [database.get_session_factory, database.get_route_generation_session_factory]


@pytest.fixture
async def unreachable_database(monkeypatch):
    monkeypatch.setattr(settings, "database_url", UNREACHABLE_DATABASE_URL)
    await database.dispose_engines()
    yield
    await database.dispose_engines()


@pytest.mark.usefixtures("unreachable_database")
@pytest.mark.parametrize("factory", FACTORIES)
async def test_a_database_that_cannot_be_reached_raises_an_error_counted_as_unavailable(factory):
    with pytest.raises(database.DB_UNAVAILABLE_ERRORS):
        async with factory()() as session:
            await session.execute(text("SELECT 1"))
