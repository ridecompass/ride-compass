"""`api/routers/ride_tracks.py`——走りの記録を受ける口。走り1回を1行で書く。

注入から本物を通し、アプリのセッション工場をテストDBへ向ける。

ここで見ないもの: 詰めた走りを GPX に直す中身 → `test_ride_track.py`
"""

import gzip
import json
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from app.api.routers.ride_tracks import MAX_DECOMPRESSED_BYTES
from app.infrastructure.ride_track_models import RideTrackRow
from app.main import app

pytestmark = pytest.mark.asyncio(loop_scope="module")

PATH = "/api/rides"


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


async def test_a_body_that_inflates_past_the_limit_is_refused_and_not_written(client, road_graph_session):
    """縮めた本文が戻すと上限を超えるなら、読み切らずに断る（鍵を照らす前に読むので、小さく縮めた巨大な本文でメモリを食わせない）。"""
    response = await client.post(PATH, **_gzipped(b" " * (MAX_DECOMPRESSED_BYTES + 1)))

    assert response.status_code == 413
    assert await _rows(road_graph_session) == []
