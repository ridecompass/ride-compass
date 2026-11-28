"""`api/routers/ride_tracks.py`——走りの記録を受ける口。ログインして同意した人の走り1回を、その人の1行で書く。
その行の表の制約（`infrastructure/ride_track_models.py`）も見る。

注入から本物を通し、アプリのセッション工場をテストDBへ向ける。

ここで見ないもの: 詰めた走りを GPX に直す中身 → `test_ride_gpx.py`、ログインと同意の口そのもの → `test_account_routes.py`
"""

import gzip
import json
from datetime import UTC, datetime
from uuid import uuid4
from xml.etree import ElementTree as ET

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.account_auth import SESSION_COOKIE
from app.api.routers.ride_tracks import MAX_DECOMPRESSED_BYTES
from app.domain.gsi_tiles import PRODUCT_PRIORITY
from app.domain.region import BoundingBox
from app.infrastructure.ride_gpx import GPX_NAMESPACE, RIDE_NAMESPACE
from app.infrastructure.account_models import AccountRow
from app.infrastructure.ride_track_models import RideTrackRow
from app.main import app
from tests.google_login import sign_in, sign_in_and_consent, use_google
from tests.source_ingest import dem_tile_records, ingest_records

pytestmark = pytest.mark.asyncio(loop_scope="module")

PATH = "/api/rides"
NS = {"g": GPX_NAMESPACE, "rc": RIDE_NAMESPACE}


def _ride(ride_id: str) -> dict:
    return {
        "id": ride_id,
        "started_at": "2026-11-16T00:12:03Z",
        "app_version": None,
        "device": "iPhone / Safari",
        "points": [[1000, 35681234, 139767124, None, 43, 555, 87, None]],
        "events": [[0, "start", None], [2000, "end", None]],
        "routes": {"r1": {"id": "loop-00", "edge_ids": ["e1", "e2"], "network_revision": 3}},
        "conditions": {"r1": {"distance_km": 40}},
        "forecasts": [{"areas": []}],
    }


@pytest_asyncio.fixture(loop_scope="module")
async def anonymous_client(road_graph_session, app_on_test_database, override_dependency):
    """ログインしていないアプリの口（Secure の cookie を送るよう https で話す）。"""
    use_google(override_dependency)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://test") as client:
        yield client


@pytest_asyncio.fixture(loop_scope="module")
async def client(anonymous_client):
    """ログインして今の規約の版に同意した人の口。"""
    await sign_in_and_consent(anonymous_client, "google-sub-a")
    return anonymous_client


def _gzipped(body: bytes) -> dict:
    """端末と同じく、本文を gzip で縮めて送る要求の中身。"""
    return {"content": gzip.compress(body), "headers": {"Content-Encoding": "gzip", "Content-Type": "application/json"}}


async def _rows(session) -> list[RideTrackRow]:
    return list((await session.execute(select(RideTrackRow))).scalars())


async def test_a_ride_with_the_key_is_written_once_even_when_sent_again(client, road_graph_session):
    """走り（gzip で縮めた本文）は GPX と、推したルート・生成の条件・予報を受けたままで1行になる。応答を失った端末が
    同じ走りを送り直しても、書けたものとして返して行を増やさない。"""
    ride_id = str(uuid4())
    for _ in range(2):
        response = await client.post(PATH, **_gzipped(json.dumps(_ride(ride_id)).encode()))
        assert response.status_code == 204

    [row] = await _rows(road_graph_session)
    [account_id] = (await road_graph_session.execute(select(AccountRow.id))).scalars()
    assert str(row.ride_id) == ride_id
    assert row.account_id == account_id
    assert '<trkpt lat="35.681234" lon="139.767124">' in row.gpx
    assert row.routes == _ride(ride_id)["routes"]
    assert row.context == {"conditions": {"r1": {"distance_km": 40}}, "forecasts": [{"areas": []}]}


async def test_the_gpx_takes_the_ground_elevation_where_the_tiles_are_and_keeps_the_device_altitude(
        client, road_graph_session):
    """GPX の標準の標高の欄は、走った地点の地形の標高（取り込んだ標高タイルを製品の並びの順に見て、値のある最初の製品）。
    取り込んだ範囲の外の点（地図の投影の範囲の外の誤った位置も）は端末の高さで、端末の高さはどの点も自前の欄に残す。"""
    area = BoundingBox(min_latitude=35.6800, min_longitude=139.7660, max_latitude=35.6830, max_longitude=139.7690)
    first, second = PRODUCT_PRIORITY[:2]
    await ingest_records("dem", [
        *dem_tile_records(first, 15, area, lambda lon, lat: None if lon > 139.7675 else 21.5),
        *dem_tile_records(second, 15, area, lambda lon, lat: 30.0),
    ])
    ride = _ride(str(uuid4())) | {"points": [
        [1000, 35681234, 139767124, 124, None, None, None, None],
        [2000, 35681234, 139768000, 125, None, None, None, None],
        [3000, 35700000, 139800000, 130, None, None, None, None],
        [4000, 100000000, 139800000, 140, None, None, None, None],
    ]}

    assert (await client.post(PATH, **_gzipped(json.dumps(ride).encode()))).status_code == 204

    [row] = await _rows(road_graph_session)
    points = ET.fromstring(row.gpx).findall(".//g:trkpt", NS)
    assert [point.findtext("g:ele", namespaces=NS) for point in points] == ["21.5", "30.0", "13.0", "14.0"]
    assert [point.findtext("g:extensions/rc:deviceAltitude", namespaces=NS) for point in points] == [
        "12.4", "12.5", "13.0", "14.0"]


async def test_a_body_that_inflates_past_the_limit_is_refused_and_not_written(client, road_graph_session):
    """縮めた本文が戻すと上限を超えるなら、読み切らずに断る（鍵を照らす前に読むので、小さく縮めた巨大な本文でメモリを食わせない）。"""
    response = await client.post(PATH, **_gzipped(b" " * (MAX_DECOMPRESSED_BYTES + 1)))

    assert response.status_code == 413
    assert await _rows(road_graph_session) == []


async def test_a_ride_is_refused_without_a_session_or_consent(anonymous_client, road_graph_session):
    """札が無い・効かなければ401、ログインしていても今の規約の版に同意していなければ403で、どちらも書かない。"""
    body = _gzipped(json.dumps(_ride(str(uuid4()))).encode())
    assert (await anonymous_client.post(PATH, **body)).status_code == 401
    anonymous_client.cookies.set(SESSION_COOKIE, "not-a-session")
    assert (await anonymous_client.post(PATH, **body)).status_code == 401

    await sign_in(anonymous_client, "google-sub-a")
    assert (await anonymous_client.post(PATH, **body)).status_code == 403
    assert await _rows(road_graph_session) == []


@pytest.mark.parametrize("empty", ["started_at", "distance_m", "duration_s"])
async def test_a_ride_of_an_account_cannot_be_written_without_its_summary(road_graph_session, empty):
    """表の制約で、利用者のある行は走り始めの時刻・距離・かかった時間のどれも空にできない。
    利用者の無い行（ログインを入れる前に受けた走り）は空のまま書ける。"""
    account = AccountRow(id=uuid4(), login_method="google", login_subject="google-sub-a")
    road_graph_session.add(account)
    road_graph_session.add(RideTrackRow(ride_id=uuid4(), gpx="", routes={}, context={}))
    await road_graph_session.flush()

    summary = {"started_at": datetime.now(UTC), "distance_m": 1000, "duration_s": 60} | {empty: None}
    road_graph_session.add(RideTrackRow(ride_id=uuid4(), gpx="", routes={}, context={}, account_id=account.id, **summary))
    with pytest.raises(IntegrityError, match="ride_tracks_summary_check"):
        await road_graph_session.flush()
