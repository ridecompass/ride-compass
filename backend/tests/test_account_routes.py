"""`api/routers/account.py`——自分の口（Google でのログイン・ログアウト・状態・同意・自分の走り）。

注入から本物を通し、アプリのセッション工場をテストDBへ向ける。Google の ID トークンの確かめはライブラリを本物で通し、
証明書の配り口だけを偽にする（`tests/google_login.py`）。

ここで見ないもの: 走りを受ける口の認可と書き込み → `test_ride_track_routes.py`、GPX の書き方 → `test_ride_gpx.py`
"""

import gzip
import json
from contextlib import asynccontextmanager
from datetime import timedelta
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import func, select, update

from app.api.account_auth import SESSION_COOKIE
from app.domain.account import SESSION_LIFETIME, TERMS_VERSION
from app.infrastructure.account_models import AccountRow
from app.infrastructure.ride_track_models import RideTrackRow
from app.main import app
from tests.google_login import (
    FORGED_KEY,
    CertsTransport,
    id_token,
    sign_in,
    sign_in_and_consent,
    use_google,
)

pytestmark = pytest.mark.asyncio(loop_scope="module")

STATUS = "/api/me"


@pytest_asyncio.fixture(loop_scope="module")
async def clients(road_graph_session, app_on_test_database, override_dependency):
    """利用者ごとのアプリの口を開く工場。cookie は口ごとに持つ（Secure の cookie を送るよう https で話す）。"""
    use_google(override_dependency)

    @asynccontextmanager
    async def open_client():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test") as client:
            yield client

    return open_client


async def _status(client) -> dict:
    response = await client.get(STATUS)
    assert response.status_code == 200
    return response.json()


async def _post_ride(client, points: list, events: list) -> str:
    ride_id = str(uuid4())
    ride = {"id": ride_id, "started_at": "2026-11-16T00:12:03Z", "app_version": None, "device": "test",
            "points": points, "events": events, "routes": {}, "conditions": {}, "forecasts": []}
    response = await client.post("/api/rides", content=gzip.compress(json.dumps(ride).encode()),
                                 headers={"Content-Encoding": "gzip", "Content-Type": "application/json"})
    assert response.status_code == 204
    return ride_id


async def test_a_google_id_token_signs_in_with_a_session_cookie_only_the_backend_can_read(clients, road_graph_session):
    """確かめた ID トークンで札を cookie に載せて返す。スクリプトから読めず・HTTPS だけで・ほかのサイトからの書き込みに付かず・
    backend の名前だけに付き・1年もつ。同じ Google のアカウントは何度ログインしても同じ利用者になる。"""
    async with clients() as client:
        response = await sign_in(client, "google-sub-a")
        assert response.status_code == 200
        assert response.json() == {"signed_in": True, "consented": False, "terms_version": TERMS_VERSION}
        cookie = response.headers["set-cookie"]
        assert cookie.startswith(f"{SESSION_COOKIE}=")
        attributes = {part.strip().split("=")[0].lower() for part in cookie.split(";")[1:]}
        assert attributes == {"max-age", "httponly", "secure", "samesite", "path"}
        assert f"Max-Age={int(SESSION_LIFETIME.total_seconds())}" in cookie
        assert "SameSite=lax" in cookie
        assert (await _status(client))["signed_in"] is True

    async with clients() as again:
        assert (await sign_in(again, "google-sub-a")).status_code == 200
    accounts = (await road_graph_session.execute(select(func.count()).select_from(AccountRow))).scalar_one()
    assert accounts == 1


@pytest.mark.parametrize("credential", [
    pytest.param(lambda: id_token("google-sub-a", key=FORGED_KEY), id="signed-by-another-key"),
    pytest.param(lambda: id_token("google-sub-a", aud="another-client"), id="for-another-client"),
    pytest.param(lambda: id_token("google-sub-a", iss="https://example.com"), id="from-another-issuer"),
    pytest.param(lambda: id_token("google-sub-a", lifetime_s=-60), id="expired"),
    pytest.param(lambda: "not-a-token", id="malformed"),
])
async def test_a_token_google_did_not_issue_for_this_client_is_refused_without_a_session(
        clients, road_graph_session, credential):
    """署名・宛先・発行元・期限のどれかが合わないトークンでは、利用者も札も作らない。"""
    async with clients() as client:
        response = await client.post("/api/me/google-login", json={"credential": credential()})
        assert response.status_code == 401
        assert "set-cookie" not in response.headers
        assert (await _status(client))["signed_in"] is False
    assert (await road_graph_session.execute(select(AccountRow))).first() is None


@pytest.mark.parametrize(("client_id", "transport", "status"), [
    pytest.param("", CertsTransport(), 503, id="no-client-id"),
    pytest.param("test-client.apps.googleusercontent.com", CertsTransport(status=500), 502, id="certs-unavailable"),
])
async def test_login_is_refused_when_it_cannot_be_checked(clients, override_dependency, client_id, transport, status):
    """クライアント ID の無い環境（ログインの設定が無い）と、Google の証明書を取れないときは、トークンの誤り（401）と分けて断る。"""
    use_google(override_dependency, client_id=client_id, transport=transport)
    async with clients() as client:
        response = await sign_in(client, "google-sub-a")
    assert response.status_code == status
    assert "set-cookie" not in response.headers


async def test_logging_out_removes_the_session_so_the_same_cookie_no_longer_signs_in(clients):
    async with clients() as client:
        await sign_in(client, "google-sub-a")
        token = client.cookies[SESSION_COOKIE]
        response = await client.post("/api/me/logout")
        assert response.status_code == 204
        assert f'{SESSION_COOKIE}=""' in response.headers["set-cookie"]
        assert (await _status(client))["signed_in"] is False

    async with clients() as stolen:
        stolen.cookies.set(SESSION_COOKIE, token)
        assert (await _status(stolen))["signed_in"] is False


async def test_a_session_lasts_for_its_lifetime(clients, clock):
    """期限は backend の札の行が持つ（cookie の期限の切れたブラウザに頼らない）。期限が来た札を送り続けてもログインにしない。"""
    async with clients() as client:
        await sign_in(client, "google-sub-a")
        token = client.cookies[SESSION_COOKIE]

    async with clients() as browser:
        browser.cookies.set(SESSION_COOKIE, token)
        clock.tick(SESSION_LIFETIME - timedelta(seconds=1))
        assert (await _status(browser))["signed_in"] is True
        clock.tick(timedelta(seconds=1))
        assert (await _status(browser))["signed_in"] is False


async def test_consent_is_given_to_the_current_terms_and_withdrawing_it_keeps_the_rides(clients):
    """同意は画面が見せた版が今の版のときだけ受け、やめると以後の走りを受けない。それまでの走りは本人の一覧に残る。"""
    async with clients() as client:
        assert (await client.put("/api/me/consent", json={"terms_version": TERMS_VERSION})).status_code == 401
        await sign_in(client, "google-sub-a")
        stale = await client.put("/api/me/consent", json={"terms_version": TERMS_VERSION - 1})
        assert stale.status_code == 409
        assert (await _status(client))["consented"] is False

        assert (await client.put("/api/me/consent", json={"terms_version": TERMS_VERSION})).status_code == 204
        assert (await _status(client))["consented"] is True
        ride_id = await _post_ride(client, [[1000, 35000000, 139000000, None, None, None, None, None]], [])

        assert (await client.delete("/api/me/consent")).status_code == 204
        assert (await _status(client)) == {"signed_in": True, "consented": False, "terms_version": TERMS_VERSION}
        assert [ride["id"] for ride in (await client.get("/api/me/rides")).json()] == [ride_id]


async def test_own_rides_are_listed_shown_and_deleted_and_others_rides_stay_hidden(clients):
    """一覧は走りの日時・距離・かかった時間を、1件は走った線を返す。休んで途切れた線はつながず、距離にも数えない。
    ほかの人の走りは、見るのも消すのも無いものとして返す。"""
    # 子午線に沿った0.009度は、半径6371kmの球で約1000.75m。休む前後の線を約10km離す。
    points = [
        [0, 35000000, 139000000, None, None, None, None, None],
        [60000, 35009000, 139000000, None, None, None, None, None],
        [300000, 35100000, 139000000, None, None, None, None, None],
        [600000, 35109000, 139000000, None, None, None, None, None],
    ]
    async with clients() as owner, clients() as other:
        await sign_in_and_consent(owner, "google-sub-a")
        await sign_in_and_consent(other, "google-sub-b")
        ride_id = await _post_ride(owner, points, [[0, "start", None], [120000, "rest", None], [600000, "end", None]])

        [summary] = (await owner.get("/api/me/rides")).json()
        assert summary["id"] == ride_id
        assert summary["started_at"] == "2026-11-16T00:12:03Z"
        assert summary["distance_m"] == pytest.approx(2001.5, abs=1)
        assert summary["duration_s"] == 600

        detail = (await owner.get(f"/api/me/rides/{ride_id}")).json()
        assert detail["track"] == {"type": "MultiLineString", "coordinates": [
            [[139.0, 35.0], [139.0, 35.009]], [[139.0, 35.1], [139.0, 35.109]]]}

        assert (await other.get("/api/me/rides")).json() == []
        assert (await other.get(f"/api/me/rides/{ride_id}")).status_code == 404
        assert (await other.delete(f"/api/me/rides/{ride_id}")).status_code == 404

        assert (await owner.delete(f"/api/me/rides/{ride_id}")).status_code == 204
        assert (await owner.get("/api/me/rides")).json() == []
        assert (await owner.get(f"/api/me/rides/{ride_id}")).status_code == 404



async def test_the_ride_list_reads_the_values_written_on_receipt_without_reading_the_gpx(clients, road_graph_session):
    """一覧は、走りを受けたときに書いた走り始めの時刻・距離・かかった時間だけを読み、GPX は読まない（走りが溜まっても重くならない）。
    GPX が読めない形になっても、一覧は返す。"""
    points = [[0, 35000000, 139000000, None, None, None, None, None], [60000, 35009000, 139000000, None, None, None, None, None]]
    async with clients() as client:
        await sign_in_and_consent(client, "google-sub-a")
        ride_id = await _post_ride(client, points, [])
        await road_graph_session.execute(update(RideTrackRow).values(gpx="読めない"))
        await road_graph_session.commit()

        [summary] = (await client.get("/api/me/rides")).json()
        assert summary == {"id": ride_id, "started_at": "2026-11-16T00:12:03Z", "distance_m": 1001, "duration_s": 60}
