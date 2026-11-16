"""`api/routers/ride_tracks.py`——走りの記録を受ける口。走り1回を1行で書く。

注入から本物を通し、アプリのセッション工場をテストDBへ向ける。

ここで見ないもの: 詰めた走りを GPX に直す中身 → `test_ride_gpx.py`
"""

import gzip
import json
from uuid import uuid4
from xml.etree import ElementTree as ET

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from app.api.routers.ride_tracks import MAX_DECOMPRESSED_BYTES
from app.domain.gsi_tiles import PRODUCT_PRIORITY
from app.domain.region import BoundingBox
from app.infrastructure.ride_gpx import GPX_NAMESPACE, RIDE_NAMESPACE
from app.infrastructure.ride_track_models import RideTrackRow
from app.main import app
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
async def client(road_graph_session, app_on_test_database):
    """アプリの口。終わりに走りの行を消す。"""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client
    await road_graph_session.execute(delete(RideTrackRow))
    await road_graph_session.commit()


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
    assert str(row.ride_id) == ride_id
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
