"""`api/routers/gsi_tile.py`——地理院の色別標高図の中継と、標高タイル（Terrain-RGB）の配信。

確かめるのは、取得の結果（中身・整備区域外・失敗）がどの応答になるかと、整備区域外の404をブラウザにも
覚えさせること、回数制限（429）、標高タイルのズームと座標の範囲（422）。取得の口（`get_gsi_tile_client`）は応答を差し替える。

ここで見ないもの:
- 配信元への取得・ディスクへの記憶・整備区域外の見分け → `test_gsi_tile_client.py`
- 標高タイルの書式の変換 → `test_gsi_dem_png.py`
- 回数制限の数え方そのもの → `test_rate_limiter.py`
"""

import logging

import pytest
from cachetools import LRUCache
from fastapi.testclient import TestClient

from app.api.cache_policy import GSI_TILE_NOT_FOUND
from app.api.dependencies import get_gsi_tile_client
from app.config import settings
from app.infrastructure import rate_limiter
from app.infrastructure.gsi_dem_png import gsi_dem_png_to_terrain_rgb
from app.infrastructure.gsi_tile_client import GsiTileClient
from app.infrastructure.http_client import UPSTREAM_NOT_FOUND
from app.main import app
from tests.fake_http import answering
from tests.source_ingest import gsi_dem_png

client = TestClient(app)

RELIEF_TILE = "/api/gsi-relief-tile/xyz/relief/12/3637/1612.png"
TERRAIN_TILE = "/api/gsi-terrain-tile/13/7276/3225.png"


class FakeGsiTileClient:
    def __init__(self, result):
        self._result = result

    async def get(self, path, *, category):
        return self._result


def _answer(override_dependency, result):
    override_dependency(get_gsi_tile_client, lambda: FakeGsiTileClient(result))


#: 経路ごとの、上流が返す中身と、利用者へ届く中身。標高タイルは変換してから配る（変換そのものは`test_gsi_dem_png.py`）。
_DEM = gsi_dem_png([[0.0, 3776.0]])
SUCCESSES = [
    (RELIEF_TILE, b"\x89PNG", b"\x89PNG"),
    (TERRAIN_TILE, _DEM, gsi_dem_png_to_terrain_rgb(_DEM)),
]


@pytest.mark.parametrize(("path", "upstream", "served"), SUCCESSES, ids=["relief", "terrain"])
def test_a_tile_is_served_as_png(override_dependency, path, upstream, served):
    _answer(override_dependency, (upstream, "image/png"))

    response = client.get(path)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/png")
    assert response.content == served


# 整備区域外（珍しくない正常系）は上流障害の502にしない。`raster-dem`は整備区域外のタイルも視界へ入るたび要求し、
# サーバー側が同じ事実をプロセス内に持って上流へ問い合わせ直さなくても、ブラウザからの要求は減らない——沿岸部を連続して
# パンする利用者は404だけでレート制限に達しうるので、恒久404はブラウザにも覚えさせる。502は一時的なので覚えさせない。
@pytest.mark.parametrize("path", [RELIEF_TILE, TERRAIN_TILE])
@pytest.mark.parametrize(("result", "status", "detail", "cache_control"), [
    (None, 502, "地理院タイルの取得に失敗しました", None),
    (UPSTREAM_NOT_FOUND, 404, "指定されたタイルは存在しません", GSI_TILE_NOT_FOUND.header()),
], ids=["failed", "outside"])
def test_a_tile_outside_the_coverage_is_told_apart_from_an_upstream_failure(
        override_dependency, path, result, status, detail, cache_control):
    _answer(override_dependency, result)

    response = client.get(path)

    assert response.status_code == status
    assert response.json() == {"detail": detail}
    assert response.headers.get("cache-control") == cache_control


@pytest.mark.parametrize(
    ("path", "category"), [(RELIEF_TILE, "gsi:relief-tile"), (TERRAIN_TILE, "gsi:dem-tile")], ids=["relief", "terrain"]
)
def test_an_upstream_failure_is_counted_under_its_own_product(override_dependency, caplog, path, category):
    """運用の統計とWARNINGは、色別標高図と標高タイルを別の名前で数える。同じ名前だと、標高タイルだけが止まった
    （地形の陰影だけが消えた）ことを色別標高図の失敗と見分けられない。"""
    override_dependency(get_gsi_tile_client, lambda: GsiTileClient(answering(503), LRUCache(maxsize=16)))
    caplog.set_level(logging.WARNING)

    client.get(path)

    named = {word for record in caplog.records if record.levelno >= logging.WARNING
             for word in record.getMessage().split() if word.startswith("[gsi:")}
    assert named == {f"[{category}]"}


@pytest.mark.parametrize(
    ("path", "upstream", "prefix"),
    [(RELIEF_TILE, b"x", "gsi-relief-tile"), (TERRAIN_TILE, _DEM, "gsi-terrain-tile")],
    ids=["relief", "terrain"],
)
def test_tiles_are_rate_limited_per_client(override_dependency, path, upstream, prefix):
    _answer(override_dependency, (upstream, "image/png"))

    for _ in range(settings.gsi_tile_rate_limit_per_minute - 1):
        rate_limiter.check_rate_limit(f"{prefix}:testclient", settings.gsi_tile_rate_limit_per_minute)
    assert client.get(path).status_code == 200

    assert client.get(path).status_code == 429


def test_標高タイルは配信元がデータを持たないズームを拒む(override_dependency):
    # 配信元はz14までしか実データを持たない。範囲外をそのまま上流へ投げない。
    _answer(override_dependency, (b"", "image/png"))

    assert client.get("/api/gsi-terrain-tile/16/58211/25802.png").status_code == 422
    assert client.get(f"/api/gsi-terrain-tile/14/{2**14}/6450.png").status_code == 422
