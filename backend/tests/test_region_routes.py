"""`api/routers/region.py`——地域の配信（路面・点・土地被覆のタイル、道の窓、押した所に近い道）のHTTPの入口。

確かめるのは、経路ごとの受け渡し（要求のどの値がサービスへ渡り、サービスの結果が応答のどこへ出るか）と、この口が
使う判断: 量ごとの値の範囲（タイル座標・走行方位・想定速度。範囲そのものは domain の型と`domain/region.py:
check_tile_index`が持ち、ここでは入口ごとにそれを使っていることを見る。土地被覆は自分のズーム範囲）、一時的に取れなかった
タイルをキャッシュさせないこと（`_tile_http.py: tile_response`）、宣言に無い点のレイヤーの404、土地被覆のラスタが無いときの
503、種類ごとに別に数えるレート制限。

差し替えるのは、注入されるサービス（`RegionService`・道の窓）・土地被覆のタイルの取得・レート制限の記録だけ。

ここで見ないもの:
- タイルの中身とキャッシュ、道の窓の道の引き当て → `test_region_service.py`・`test_landcover_tile.py`
- 地図のレンズの口と、道の窓のレンズの値 → `test_region_lens.py`
- キャッシュの方針の表・圧縮する種類 → `test_cache_policy.py`・`test_response_compression.py`
- レート制限の数え方そのもの → `test_rate_limiter.py`
- 同時実行の上限（semaphore）。待たせるだけで、応答には現れない
"""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.api import dependencies
from app.api.cache_policy import BATCH_TILE
from app.api.dependencies import get_region_service, get_road_inspector_service
from app.config import settings
from app.domain.lens_values import LensInspection, RoadInspection
from app.domain.region import (
    ROAD_SURFACE_TILE_MIN_ZOOM,
    ROAD_TILE_MAX_ZOOM,
    ROAD_TILE_MIN_ZOOM,
    ROADS_AT_MAX_RADIUS_M,
    RoadAt,
)
from app.infrastructure import rate_limiter
from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS
from app.domain.cost_preference import CostPreference
from app.main import app
from app.domain.landcover import LANDCOVER_TILE_MAX_ZOOM
from tests.bound_fake import bound

client = TestClient(app)

POINT_LAYER = next(iter(POINT_TILE_LAYERS))


class FakeRegionService:
    def __init__(self, tile_bytes=b"\x00\x01\x02", roads: list[RoadAt] | None = None):
        self._tile_bytes = tile_bytes
        self._roads = roads or []
        # 頼まれたタイル（点のレイヤーの名前・路面ならNone、z、x、y）
        self.tile_request = None
        # 頼まれた近い道（経度、緯度、z、拾う距離）
        self.roads_request = None

    async def get_road_surface_tile(self, z, x, y):
        self.tile_request = (None, z, x, y)
        return self._tile_bytes

    async def get_point_tile(self, layer, z, x, y):
        self.tile_request = (layer.name, z, x, y)
        return self._tile_bytes

    async def roads_at(self, lon, lat, z, radius_m):
        self.roads_request = (lon, lat, z, radius_m)
        return self._roads

class FakeRoadInspector:
    """道の窓の代役。受け取ったものを残し、決めた結果を返す。"""

    def __init__(self, result: RoadInspection | None = None):
        self._result = result
        self.request = None

    async def inspect(self, osm_way_id, feature_key, tile, bearing_deg, at, speed_kmh, cost_preference):
        self.request = (osm_way_id, feature_key, tile, bearing_deg, at, speed_kmh, cost_preference)
        return self._result


#: 道の窓の要求が必ず運ぶもの（押した道・押したフィーチャー・押したタイル・走行方位・想定速度）。
INSPECTED = {"osm_way_id": 12345, "feature_key": "12345-0", "z": 14, "x": 14551, "y": 6447, "bearing_deg": 90.0,
             "speed_kmh": 20.0}
#: 押した所に近い道の要求。
PRESSED = {"longitude": 139.70, "latitude": 35.68, "z": 14, "radius_m": 30.0}


@pytest.mark.parametrize(
    ("path", "requested"),
    [
        ("/api/region/road-surface-tiles/14/14551/6447.pbf", (None, 14, 14551, 6447)),
        (f"/api/region/point-tiles/{POINT_LAYER}/14/14551/6447.pbf", (POINT_LAYER, 14, 14551, 6447)),
    ],
)
def test_region_tiles_hand_the_services_mvt_over(override_dependency, path, requested):
    tile = bytes(range(256)) * 40  # 圧縮する大きさを超える
    fake = FakeRegionService(tile_bytes=tile)
    override_dependency(get_region_service, lambda: fake)

    response = client.get(path, headers={"Accept-Encoding": "gzip"})

    assert response.status_code == 200
    assert response.content == tile
    assert response.headers["content-type"] == "application/vnd.mapbox-vector-tile"
    assert response.headers["content-encoding"] == "gzip"
    assert response.headers["cache-control"] == BATCH_TILE.header()
    assert fake.tile_request == requested


# 外れた値がサービスまで届くと、domain の前提（速度は正・方位は有限・列と行はズームの範囲の中）が崩れて500になるか、
# 在りもしない範囲を引く。入口ごとに、量の型と列・行の上限の検査を使っていることを1行ずつ見る。
@pytest.mark.parametrize(
    ("path", "body"),
    [
        (f"/api/region/road-surface-tiles/{ROAD_SURFACE_TILE_MIN_ZOOM - 1}/0/0.pbf", None),
        (f"/api/region/road-surface-tiles/{ROAD_TILE_MAX_ZOOM + 1}/0/0.pbf", None),
        ("/api/region/road-surface-tiles/14/-1/6447.pbf", None),
        (f"/api/region/road-surface-tiles/14/{2**14}/6447.pbf", None),
        (f"/api/region/road-surface-tiles/14/14551/{2**14}.pbf", None),
        (f"/api/region/point-tiles/{POINT_LAYER}/{ROAD_TILE_MIN_ZOOM - 1}/0/0.pbf", None),
        (f"/api/region/point-tiles/{POINT_LAYER}/14/{2**14}/6447.pbf", None),
        (f"/api/region/landcover-tiles/{LANDCOVER_TILE_MAX_ZOOM + 1}/1/1.png", None),
        (f"/api/region/landcover-tiles/10/{2**10}/403.png", None),
        ("/api/region/road-inspector", {**INSPECTED, "z": ROAD_TILE_MAX_ZOOM + 1}),
        ("/api/region/road-inspector", {**INSPECTED, "x": 2**14}),
        ("/api/region/road-inspector", {**INSPECTED, "bearing_deg": 360.0}),
        ("/api/region/road-inspector", {**INSPECTED, "speed_kmh": 0.0}),
        ("/api/region/roads-at", {**PRESSED, "z": ROAD_TILE_MIN_ZOOM - 1}),
        ("/api/region/roads-at", {**PRESSED, "radius_m": ROADS_AT_MAX_RADIUS_M + 1}),
        ("/api/region/roads-at", {**PRESSED, "latitude": 91.0}),
    ],
)
def test_region_requests_outside_each_quantitys_range_are_refused(override_dependency, path, body):
    override_dependency(get_region_service, lambda: FakeRegionService())
    override_dependency(get_road_inspector_service, lambda: FakeRoadInspector())

    response = client.get(path) if body is None else client.post(path, json=body)

    assert response.status_code == 422


def test_region_point_tile_rejects_an_undeclared_layer(override_dependency):
    override_dependency(get_region_service, lambda: FakeRegionService())

    response = client.get("/api/region/point-tiles/no-such-layer/14/14551/6447.pbf")

    assert response.status_code == 404


def test_each_kind_of_region_request_is_counted_on_its_own(override_dependency):
    """路面・点のレイヤーごと・道の窓・押した所に近い道は、それぞれ別の回数で上限に当たる。

    回数を分け合うと、1つの種類の取得だけでほかの種類の上限を先に使い切り、地図の別のレイヤーが描かれなくなる。
    """
    limit = settings.road_tile_rate_limit_per_minute
    exhausted_layer, *other_layers = POINT_TILE_LAYERS
    road = "/api/region/road-surface-tiles/14/14551/6447.pbf"
    point = "/api/region/point-tiles/{}/14/14551/6447.pbf"
    override_dependency(get_region_service, lambda: FakeRegionService())
    override_dependency(get_road_inspector_service, lambda: FakeRoadInspector())

    # 上限-1件は実HTTPを経由せず記録を直接埋め、境界の1回だけ実リクエストで見る。
    for key in ("road-tile", f"{exhausted_layer}-tile"):
        for _ in range(limit - 1):
            rate_limiter.check_rate_limit(f"{key}:testclient", limit)
    exhausted_point = point.format(exhausted_layer)
    exhausted = [client.get(path).status_code for path in (road, road, exhausted_point, exhausted_point)]
    others = [client.get(point.format(layer)).status_code for layer in other_layers]
    others.append(client.post("/api/region/road-inspector", json=INSPECTED).status_code)
    others.append(client.post("/api/region/roads-at", json=PRESSED).status_code)

    assert exhausted == [200, 429, 200, 429]
    assert other_layers
    assert others == [200] * len(others)


def test_region_road_inspector_hands_the_pressed_feature_and_the_maps_conditions_over(override_dependency):
    """押した道・フィーチャー・タイルと、地図が指定している走行方位・時刻・想定速度・利用者の値がサービスへ渡り、その結果が
    応答になる。

    条件が届かないと、1本の道が往復2方向で違う値を持つレンズを地図と同じ値で出せない。フィーチャーが届かないと、押した物とは
    別の物の値が出る。
    """
    result = RoadInspection(highway="primary", tags={},
                            lens=LensInspection(painted="along", along=None, against=None))
    fake = FakeRoadInspector(result)
    override_dependency(get_road_inspector_service, lambda: fake)
    response = client.post(
        "/api/region/road-inspector",
        json={**INSPECTED, "at": "2026-09-21T09:00:00+00:00", "cost_preference": {"strength": 2.0}},
    )

    assert response.status_code == 200
    assert response.json() == result.model_dump()
    assert fake.request == (
        12345, "12345-0", (14, 14551, 6447), 90.0, datetime(2026, 9, 21, 9, 0, tzinfo=timezone.utc), 20.0,
        CostPreference(strength=2.0),
    )


def test_region_roads_at_hands_the_pressed_place_over(override_dependency):
    """押した所・地図のズーム・拾う距離がサービスへ渡り、近い順の道が応答になる。"""
    roads = [RoadAt(properties={"feature_key": "1", "osm_way_id": 1}, shape=[(139.70, 35.68), (139.71, 35.68)])]
    fake = FakeRegionService(roads=roads)
    override_dependency(get_region_service, lambda: fake)

    response = client.post("/api/region/roads-at", json=PRESSED)

    assert response.status_code == 200
    assert response.json() == [road.model_dump(mode="json") for road in roads]
    assert fake.roads_request == (139.70, 35.68, 14, 30.0)


# ---- 土地被覆ラスタタイル（`/api/region/landcover-tiles`） ----


@pytest.fixture
def landcover_tiles(override_dependency):
    """配信の口が呼ぶタイルの取得（サービス）の代役。返す値は`result`で決め、呼ばれた座標を`calls`に残す。"""
    state = {"result": None, "calls": []}

    async def fake(z, x, y):
        state["calls"].append((z, x, y))
        return state["result"]

    reader = bound(dependencies.get_landcover_tile_reader(), fake)
    override_dependency(dependencies.get_landcover_tile_reader, lambda: reader)
    yield state


def test_landcover_tile_endpoint_returns_the_tile_as_png(landcover_tiles):
    landcover_tiles["result"] = b"png-bytes"

    response = client.get("/api/region/landcover-tiles/10/905/403.png")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.text == "png-bytes"
    assert landcover_tiles["calls"] == [(10, 905, 403)]
