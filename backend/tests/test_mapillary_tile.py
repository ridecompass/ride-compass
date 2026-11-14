"""Mapillary の街灯の点と撮影の線の取得と取込（アダプタ`mapillary_map_feature_point`・`mapillary_sequence`）。

入口は取得の入口（`app/batch/fetch_cli.py: fetch_sources`）と取込（`ingest_source`）。タイルの口の応答（`respx_mock`）・置き場・鍵だけを
差し替え、ズーム14のタイル2枚（東西に並ぶ）に掛かる範囲で、本物の宣言のまま取って生データに入った行を見る。

ここで見ないもの:
- 置き場の前のものを消すこと → `test_fetch_cli.py`
"""

import asyncio
import json

import httpx
import mapbox_vector_tile
import pytest
from shapely import wkb
from shapely.geometry import LineString, Point

from app.batch.common import FetchError
from app.batch.fetch_cli import fetch_sources
from app.batch.ingest import ingest_source
from app.batch.source_adapters import mapillary_tile
from app.config import settings
from app.domain.region import tile_bounds_lonlat, tile_position
from app.infrastructure.source_models import Source
from tests.source_ingest import profile_within

pytestmark = pytest.mark.asyncio(loop_scope="module")

#: 範囲が掛かるタイル（東京の中心）。東の隣のタイルとの2枚に掛ける。
ZOOM, X, Y = 14, 14552, 6451
WEST, EAST = (X, Y), (X + 1, Y)
EXTENT = 4096

_west, _east = tile_bounds_lonlat(ZOOM, *WEST), tile_bounds_lonlat(ZOOM, *EAST)
_height = _west.max_latitude - _west.min_latitude
#: 範囲は2枚の東西の全部と、南北の真ん中の半分。タイルの北の端の地物は範囲の枠の外になる。
PROFILE = profile_within((_west.min_latitude + _height / 4, _west.min_longitude + 1e-6,
                          _west.max_latitude - _height / 4, _east.max_longitude - 1e-6))
STREET_LIGHT = PROFILE.source(Source.MAPILLARY_STREET_LIGHT).rows.values[0]

#: 配られる点の層（タイルの中の座標。左上が原点で下へ増える）。
POINTS = {
    WEST: [(Point(1024, 1500), {"id": 1, "value": STREET_LIGHT, "first_seen_at": 1700000000000}),
           (Point(1024, 2048), {"id": 2, "value": "object--traffic-sign--front"}),
           (Point(2048, 100), {"id": 3, "value": STREET_LIGHT})],
    EAST: [(Point(10, 3000), {"id": 4, "value": STREET_LIGHT})],
}
#: 配られる撮影の線の層。1本の線が2枚のタイルの境で切れて、両方のタイルに切れ端が配られる。
SEQUENCES = {
    WEST: [(LineString([(3000, 2048), (4096, 2048)]), {"id": "seq", "captured_at": 1774316477960, "is_pano": False})],
    EAST: [(LineString([(0, 2048), (500, 2100)]), {"id": "seq", "captured_at": 1774316477960, "is_pano": False})],
}


def _tile(layer: str, features) -> bytes:
    return mapbox_vector_tile.encode(
        [{"name": layer, "features": [{"geometry": geometry, "properties": properties} for geometry, properties in features]},
         # 撮影の線の口は、写真の点の層も同じタイルで配る。
         {"name": "image", "features": [{"geometry": Point(5, 5), "properties": {"id": 9}}]}],
        default_options={"y_coord_down": True, "extents": EXTENT})


TILES = {"mly_map_feature_point": ("point", POINTS), "mly1_public": ("sequence", SEQUENCES)}


def _serve(respx_mock, refused: set[tuple[int, int]] = frozenset()) -> list[tuple[str, int, int]]:
    """タイルの口の代役。`refused`のタイルには403を返す。読まれたタイルの (タイルセット, x, y) を順に返す。"""
    requested = []

    def respond(request, tileset: str, z: str, x: str, y: str):
        assert request.url.params["access_token"] == settings.mapillary_token
        tile = (int(x), int(y))
        requested.append((tileset, *tile))
        if tile in refused:
            return httpx.Response(403)
        layer, features = TILES[tileset]
        return httpx.Response(200, content=_tile(layer, features.get(tile, [])))

    respx_mock.get(url__regex=r"^https://tiles\.mapillary\.com/maps/vtp/(?P<tileset>\w+)/2/(?P<z>\d+)/(?P<x>\d+)/(?P<y>\d+)").mock(
        side_effect=respond)
    return requested


@pytest.fixture
def store(monkeypatch, tmp_path):
    """置き場を一時ディレクトリへ移し、鍵を与える。"""
    monkeypatch.setattr(mapillary_tile, "DATA_DIR", tmp_path)
    monkeypatch.setattr(settings, "mapillary_token", "given-token")


async def _fetch(sources: list[str]) -> None:
    """取得の入口は自分でイベントループを回すので、テストのループの外（別のスレッド）で打つ。"""
    await asyncio.to_thread(fetch_sources, PROFILE, sources)


async def _rows(conn, source: str) -> dict[str, dict]:
    return {row["natural_key"]: {"geom": wkb.loads(bytes(row["geom"])), "attrs": json.loads(row["attrs"])}
            for row in await conn.fetch(
                "SELECT natural_key, ST_AsBinary(geom) AS geom, attrs FROM source_features WHERE source = $1", source)}


async def test_宣言の種類の街灯の点と撮影の線の切れ端を範囲の枠に掛かるものだけ配られた属性のまま入れる(derive_conn, respx_mock, store):
    """タイルの中の座標を緯度経度へ移し違えると、街灯が別の道に付く。線の切れ端を1つの鍵にまとめると、片方の切れ端が消える。"""
    _serve(respx_mock)

    await _fetch([Source.MAPILLARY_STREET_LIGHT, Source.MAPILLARY_SEQUENCE])
    await ingest_source(derive_conn, PROFILE, Source.MAPILLARY_STREET_LIGHT)
    await ingest_source(derive_conn, PROFILE, Source.MAPILLARY_SEQUENCE)

    lights = await _rows(derive_conn, Source.MAPILLARY_STREET_LIGHT)
    assert set(lights) == {"1", "4"}
    assert lights["1"]["attrs"]["first_seen_at"] == 1700000000000
    assert tile_position(lights["1"]["geom"].x, lights["1"]["geom"].y, ZOOM) == pytest.approx(
        (X + 1024 / EXTENT, Y + 1500 / EXTENT), abs=1e-6)
    sequences = await _rows(derive_conn, Source.MAPILLARY_SEQUENCE)
    assert set(sequences) == {f"seq/{ZOOM}/{X}/{Y}", f"seq/{ZOOM}/{X + 1}/{Y}"}
    assert sequences[f"seq/{ZOOM}/{X}/{Y}"]["attrs"] == SEQUENCES[WEST][0][1]
    west_piece = sequences[f"seq/{ZOOM}/{X}/{Y}"]["geom"]
    assert west_piece.coords[-1][0] == pytest.approx(_west.max_longitude)


async def test_断られたら置いたタイルを残して止まり_次は残りのタイルから続ける(derive_conn, respx_mock, store):
    """続けずに初めから読み直すと、1日の上限で断られるたびに同じタイルを読み、取り直しがいつまでも終わらない。"""
    first = _serve(respx_mock, refused={EAST})
    with pytest.raises(FetchError, match="403"):
        await _fetch([Source.MAPILLARY_STREET_LIGHT])
    assert first == [("mly_map_feature_point", *WEST), ("mly_map_feature_point", *EAST)]

    respx_mock.reset()
    second = _serve(respx_mock)
    await _fetch([Source.MAPILLARY_STREET_LIGHT])
    await ingest_source(derive_conn, PROFILE, Source.MAPILLARY_STREET_LIGHT)

    assert second == [("mly_map_feature_point", *EAST)]
    assert set(await _rows(derive_conn, Source.MAPILLARY_STREET_LIGHT)) == {"1", "4"}
