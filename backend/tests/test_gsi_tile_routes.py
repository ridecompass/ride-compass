"""`api/routers/gsi_tile.py`——地理院の標高タイル（Terrain-RGB）の配信。

確かめるのは、取得の結果（中身・整備区域外）がどの応答になるかと、整備区域外の404をブラウザにも
覚えさせること、回数制限（429）、標高タイルのズームと座標の範囲（422）。取得の口（`get_gsi_tile_client`）は応答を差し替える。

ここで見ないもの:
- 配信元への取得・ディスクへの記憶・整備区域外の見分け → `test_gsi_tile_client.py`
- 標高タイルの書式の変換 → `test_gsi_dem_png.py`
- 回数制限の数え方そのもの → `test_rate_limiter.py`
"""

from fastapi.testclient import TestClient

from app.api.cache_policy import GSI_TILE_NOT_FOUND
from app.api.dependencies import get_gsi_tile_client
from app.config import settings
from app.infrastructure import rate_limiter
from app.infrastructure.gsi_dem_png import gsi_dem_png_to_terrain_rgb
from app.infrastructure.http_client import UPSTREAM_NOT_FOUND
from app.main import app
from tests.source_ingest import gsi_dem_png

client = TestClient(app)

TERRAIN_TILE = "/api/gsi-terrain-tile/13/7276/3225.png"


class FakeGsiTileClient:
    def __init__(self, result):
        self._result = result

    async def get(self, path):
        return self._result


def _answer(override_dependency, result):
    override_dependency(get_gsi_tile_client, lambda: FakeGsiTileClient(result))


#: 上流が返す標高タイル。変換してから配る（変換そのものは`test_gsi_dem_png.py`）。
_DEM = gsi_dem_png([[0.0, 3776.0]])


def test_a_tile_is_served_as_terrain_rgb_png(override_dependency):
    _answer(override_dependency, (_DEM, "image/png"))

    response = client.get(TERRAIN_TILE)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/png")
    assert response.content == gsi_dem_png_to_terrain_rgb(_DEM)


# 整備区域外（珍しくない正常系）は上流障害の502にしない。`raster-dem`は整備区域外のタイルも視界へ入るたび要求し、
# サーバー側が同じ事実をプロセス内に持って上流へ問い合わせ直さなくても、ブラウザからの要求は減らない——沿岸部を連続して
# パンする利用者は404だけでレート制限に達しうるので、恒久404はブラウザにも覚えさせる。
def test_a_tile_outside_the_coverage_is_told_apart_from_an_upstream_failure(override_dependency):
    _answer(override_dependency, UPSTREAM_NOT_FOUND)

    response = client.get(TERRAIN_TILE)

    assert response.status_code == 404
    assert response.json() == {"detail": "指定されたタイルは存在しません"}
    assert response.headers.get("cache-control") == GSI_TILE_NOT_FOUND.header()


def test_tiles_are_rate_limited_per_client(override_dependency):
    _answer(override_dependency, (_DEM, "image/png"))

    for _ in range(settings.gsi_tile_rate_limit_per_minute - 1):
        rate_limiter.check_rate_limit("gsi-terrain-tile:testclient", settings.gsi_tile_rate_limit_per_minute)
    assert client.get(TERRAIN_TILE).status_code == 200

    assert client.get(TERRAIN_TILE).status_code == 429


def test_標高タイルは配信元がデータを持たないズームを拒む(override_dependency):
    # 配信元はz14までしか実データを持たない。範囲外をそのまま上流へ投げない。
    _answer(override_dependency, (b"", "image/png"))

    assert client.get("/api/gsi-terrain-tile/16/58211/25802.png").status_code == 422
    assert client.get(f"/api/gsi-terrain-tile/14/{2**14}/6450.png").status_code == 422
