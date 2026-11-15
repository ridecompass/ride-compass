"""`scripts/serve_without_db.py`——起こし方の入口から起こした本体が、DBを読まずに起きて、DBを読まない口を返す。

入口（`serve_without_db.py: serve`）は本物を通し、最後のサーバーを回す所（uvicorn）だけを、渡されたアプリと住所を受け取る
ものに替える。受け取ったアプリを TestClient で起こし、起動の段を通す。DBは、セッションの工場を引いたら落ちるようにして見る
（本体が名前で読み込んだものと、DBの口の元の両方）。
"""

import pytest
from fastapi.testclient import TestClient

import serve_without_db
from app import main
from app.infrastructure import database


def reading_the_database():
    raise AssertionError("起動の段がDBを読んだ")


@pytest.fixture
def served(monkeypatch):
    """入口から起こしたときに、サーバーへ渡されたもの（アプリ・住所・番号）。"""
    monkeypatch.setattr(main, "get_session_factory", reading_the_database)
    monkeypatch.setattr(database, "get_session_factory", reading_the_database)
    # 入口は本体の起動の段を書き換えるので、終わったら戻す。
    monkeypatch.setattr(main.app.router, "lifespan_context", main.app.router.lifespan_context)
    passed = {}
    monkeypatch.setattr(serve_without_db.uvicorn, "run", lambda app, host, port: passed.update(app=app, host=host, port=port))
    serve_without_db.serve("127.0.0.1", 8123)
    return passed


def test_the_backend_starts_without_reading_the_database_and_answers(served):
    with TestClient(served["app"]) as client:
        response = client.get("/health")

    assert (served["host"], served["port"]) == ("127.0.0.1", 8123)
    assert response.status_code == 200
