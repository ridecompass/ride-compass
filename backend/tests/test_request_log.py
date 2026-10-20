"""リクエストID・アクセスサマリログ(infrastructure/request_log.py)のテスト。

.claude/rules/logging.mdの方針のうち「クライアント指定のX-Request-IDを応答とログ行へ引き継ぐ」
「アクセスサマリのレベルはステータス・経路で変わる」「未処理例外はスタックトレース付きERRORで残り、
500応答にもIDが付く」を守る。ログ行の時刻がJSTで、オフセットを名乗ることも併せて検査する
（書式はこのモジュールが1つだけ持つ）。

ここで見ないもの: IDの形式の確かめ方・指定が無いときの発行 → `asgi_correlation_id`の持ち物
"""

import calendar
import logging
import re

import pytest
from asgi_correlation_id import CorrelationIdMiddleware
from fastapi import FastAPI, Response
from fastapi.testclient import TestClient

from app.api.cache_policy import TILE_PATH_PREFIXES
from app.main import app as main_app
from app.infrastructure.request_log import (
    access_level,
    format_log_lines,
    request_log_middleware,
    unhandled_exception_handler,
)

CLIENT_REQUEST_ID = "0f8fad5bd9cb469fa16570867728950e"


def test_access_log_line_carries_the_request_id(caplog):
    """アクセスログの行にも応答と同じIDが載る。載らないと、利用者の手元のIDで行を探せない。"""
    caplog.set_level(logging.INFO, logger="ridecompass.access")
    format_log_lines(caplog.handler)
    client = TestClient(main_app)
    client.get("/health", headers={"X-Request-ID": CLIENT_REQUEST_ID})

    records = [r for r in caplog.records if r.name == "ridecompass.access"]
    assert len(records) == 1
    line = caplog.handler.format(records[0])
    assert f"[req:{CLIENT_REQUEST_ID}]" in line


@pytest.mark.parametrize(
    ("path", "status_code", "level"),
    [
        # タイル系(高頻度)の成功と「そのタイルは無い」404はDEBUG、通常エンドポイントの成功はINFO。
        ("/api/basemap/tiles/1", 200, logging.DEBUG),
        ("/api/jma-tile/bosai/jmatile/data/1.png", 404, logging.DEBUG),
        ("/api/jma-tile-index", 200, logging.INFO),
        # 4xxはWARNING(ただし429は別途record_rate_limit_rejectionが出すためDEBUG)、5xxはERROR。
        ("/api/gsi-terrain-tile/20/1/1.png", 400, logging.WARNING),
        ("/api/routes/generate", 404, logging.WARNING),
        ("/api/routes/generate", 429, logging.DEBUG),
        ("/api/basemap/tiles/1", 502, logging.ERROR),
    ],
)
def test_access_level_policy(path, status_code, level):
    assert access_level(path, status_code, TILE_PATH_PREFIXES) == level


def _app_with_access_log() -> FastAPI:
    """アクセスログのミドルウェアだけを載せたアプリ。タイルの経路の404と、未処理例外の経路を持つ。"""
    test_app = FastAPI()
    test_app.middleware("http")(request_log_middleware(TILE_PATH_PREFIXES))

    @test_app.get("/api/basemap/missing")
    def missing_tile():
        return Response(status_code=404)

    @test_app.get("/boom")
    def boom():
        raise RuntimeError("kaboom")

    return test_app


def _access_records(caplog) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == "ridecompass.access"]


def test_access_log_line_reports_the_request_at_the_level_of_its_path(caplog):
    """1行がメソッド・経路・状態・所要・接続元を持ち、レベルは経路のタイルの接頭辞と状態で決まる。

    タイルの404がWARNINGへ上がると、視界の分だけ並ぶ正常な404で運用のログが埋まる。
    """
    caplog.set_level(logging.DEBUG, logger="ridecompass.access")
    TestClient(_app_with_access_log()).get("/api/basemap/missing")

    [record] = _access_records(caplog)
    assert record.levelno == logging.DEBUG
    assert re.fullmatch(r"GET /api/basemap/missing -> 404 in \d+ms client=testclient", record.getMessage())


def test_access_log_line_names_unknown_client_when_the_server_gives_none(caplog):
    """ASGIの`client`はUnixソケット越し等で None になる。そのときも1行を出し、接続元は`unknown`と書く。"""
    inner = _app_with_access_log()

    async def without_client(scope, receive, send):
        await inner({**scope, "client": None}, receive, send)

    caplog.set_level(logging.DEBUG, logger="ridecompass.access")
    TestClient(without_client).get("/api/basemap/missing")

    [record] = _access_records(caplog)
    assert re.fullmatch(r"GET /api/basemap/missing -> 404 in \d+ms client=unknown", record.getMessage())


def test_unhandled_exception_logged_as_error_with_traceback(caplog):
    caplog.set_level(logging.ERROR, logger="ridecompass.access")

    with pytest.raises(RuntimeError):
        TestClient(_app_with_access_log()).get("/boom")

    [record] = _access_records(caplog)
    assert record.levelno == logging.ERROR
    assert re.fullmatch(r"GET /boom -> unhandled exception after \d+ms client=testclient", record.getMessage())
    assert record.exc_info is not None


# 未処理例外(500)でもX-Request-IDヘッダが付く。TestClientは既定で
# raise_server_exceptions=Trueのため、実際のHTTPレスポンスを得るにはFalseを指定する。
def test_unhandled_exception_response_has_request_id_header():
    test_app = FastAPI()
    test_app.middleware("http")(request_log_middleware(TILE_PATH_PREFIXES))
    test_app.add_middleware(CorrelationIdMiddleware)
    test_app.add_exception_handler(Exception, unhandled_exception_handler)

    @test_app.get("/boom")
    def boom():
        raise RuntimeError("kaboom")

    client = TestClient(test_app, raise_server_exceptions=False)
    response = client.get("/boom", headers={"X-Request-ID": CLIENT_REQUEST_ID})

    assert response.status_code == 500
    assert response.headers["X-Request-ID"] == CLIENT_REQUEST_ID


def _formatted_line(created_utc: tuple[int, int, int, int, int, int], msecs: float) -> str:
    """UTCの壁時計を与えて、1レコードを整形した行を返す。"""
    record = logging.LogRecord("ridecompass.test", logging.INFO, "/x", 1, "本文", (), None)
    record.created = calendar.timegm((*created_utc, 0, 0, 0)) + msecs / 1000
    record.msecs = msecs
    handler = logging.Handler()
    format_log_lines(handler)
    handler.filter(record)
    return handler.format(record)


def test_log_time_is_written_in_jst_with_its_offset():
    """コンテナのTZ（UTC）ではなくJSTの壁時計で書き、行が自分の時間帯を名乗る。

    ずれたままだと、ブラウザ側のデバッグログ（利用者のローカル時刻）が示す時刻で
    backendのログを探したとき、9時間離れた窓を見て「該当ログなし」と読んでしまう。
    """
    line = _formatted_line((2026, 9, 18, 0, 0, 30), 840)

    assert line.startswith("2026-09-18 09:00:30,840+0900")
