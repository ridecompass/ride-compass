"""`infrastructure/region_tile_cache.py`——地域タイルのディスクの口（キャッシュ確認・取得・キャッシュ書き込みの骨格と、旧世代の掃除・作り直しのあとの捨て）。

ここで見ないもの:
- 各タイル種別の取得の仕方 → `test_landcover_tile.py`等、種別ごとのテスト
- ディスクのキャッシュの読み書きと、読めない・消せないときの扱い → `test_tile_cache.py`
- 記録した項目のログ・統計への出し方 → `test_debug_log.py`

ディスクのキャッシュは本物で通す（置き場は`tests/conftest.py`がテストごとの一時ディレクトリへ向けてある）。骨格のテストは
記録の口（`log_external_call`）を、旧世代の掃除のテストはラスタの口を代役にする。
"""


import pytest

import numpy as np

from app.domain.feature_materials import FeatureMaterials
from app.infrastructure import feature_material_cache, region_tile_cache, tile_cache
from app.infrastructure.cache_identity import LANDCOVER_TILE_VERSION, region_tile_key
from app.infrastructure.landcover_raster import raster_paths
from tests.fake_external_log import record_external_calls

EMPTY = b"empty-tile"
TILE = {"kind": "kind", "generation": "1", "z": 10, "x": 905, "y": 403, "extension": "png"}
KEY = region_tile_key(**TILE)


@pytest.fixture
def records(monkeypatch):
    """記録の口へ渡った呼び出しと、処理の最後に残った項目。"""
    return record_external_calls(monkeypatch, region_tile_cache)


def _fetch(result):
    async def fetch(fields):
        return result

    return fetch


async def _serve(fetch, **overrides):
    arguments = {
        **TILE,
        "empty_tile": EMPTY,
        "content_type": "image/png",
        "external_call_name": "kind-tile",
        "fetch_tile": fetch,
        "source_label": "raster",
        **overrides,
    }
    return await region_tile_cache.serve_region_tile(**arguments)


async def test_a_cached_tile_is_returned_without_making_it_again(records):
    tile_cache.set(KEY, b"cached", "image/png")
    fetch = _fetch(b"new")

    response = await _serve(fetch)

    assert response == b"cached"
    assert records[0].fields["cache"] == "hit"


async def test_a_missing_tile_is_made_stored_and_returned(records):
    fetch = _fetch(b"new")

    response = await _serve(fetch)

    assert response == b"new"
    assert tile_cache.get(KEY) == (b"new", "image/png")
    # 取得元は呼び出し元が名乗る（統計の内訳が実際の取得元と食い違わないため）
    assert [call.fields for call in records] == [{
        "z": TILE["z"], "x": TILE["x"], "y": TILE["y"],
        "cache": "miss", "source": "raster", "tile_bytes": 3,
    }]


async def test_a_tile_outside_the_coverage_is_the_empty_tile_and_is_not_stored(records):
    response = await _serve(_fetch(None))

    assert response == EMPTY
    assert tile_cache.get(KEY) is None
    assert records[0].fields["source"] == "uncovered_empty"


# ---- 旧世代の掃除 ----


@pytest.fixture
def configure_rasters(raster_dir):
    """土地被覆ラスタの置き場を、名前を渡したファイルだけにする口（世代はファイルの名前の集合で決まり、中身は読まない）。"""

    def configure(*names: str) -> None:
        for path in raster_dir.iterdir():
            path.unlink()
        for name in names:
            (raster_dir / name).write_bytes(b"")

    configure("53S_2024.tif")
    return configure


def _store(*keys: str) -> None:
    for key in keys:
        tile_cache.set(key, b"tile", "application/octet-stream")


def _kept(*keys: str) -> set[str]:
    return {key for key in keys if tile_cache.get(key) is not None}


def test_only_the_generations_being_served_stay_on_disk(configure_rasters):
    configure_rasters("53S_2024.tif", "54S_2024.tif")
    landcover_with_another_zone = region_tile_cache.landcover_generation(raster_paths())
    configure_rasters("53S_2024.tif")
    landcover_now = region_tile_cache.landcover_generation(raster_paths())
    road_surface_now = region_tile_cache.MVT_TILE_GENERATIONS["road_surface"]
    keys = {
        "路面の今の形": region_tile_key("road_surface", road_surface_now, 12, 1, 1, "pbf"),
        "路面の前の形": region_tile_key("road_surface", "another-shape", 12, 1, 1, "pbf"),
        "表に無い系統": region_tile_key("road-surface", road_surface_now, 12, 1, 1, "pbf"),
        "土地被覆の今のラスタ構成": region_tile_key("landcover", landcover_now, 12, 1, 1, "png"),
        "土地被覆の別のラスタ構成": region_tile_key("landcover", landcover_with_another_zone, 12, 1, 1, "png"),
        "基礎地図（地域タイルでない）": "styles/liberty",
    }
    _store(*keys.values())

    removed = region_tile_cache.prune_other_generations()

    kept = _kept(*keys.values())
    assert {name for name, key in keys.items() if key in kept} == {
        "路面の今の形",
        "土地被覆の今のラスタ構成",
        "基礎地図（地域タイルでない）",
    }
    assert removed == len(keys) - len(kept)


def test_the_landcover_generation_carries_the_tile_version(configure_rasters):
    """配色を変えて版を上げたら、前の版の絵をディスクから返さない。"""
    assert region_tile_cache.landcover_generation(raster_paths()).startswith(f"{LANDCOVER_TILE_VERSION}/")


async def test_discarding_after_a_rebuild_drops_every_region_tile_and_the_feature_materials(configure_rasters):
    """作り直しのあと、前の表で焼いた絵と材料を配らない。基礎地図は表から作らないので残す。"""
    landcover = region_tile_cache.landcover_generation(raster_paths())
    region_keys = [
        region_tile_key("road_surface", region_tile_cache.MVT_TILE_GENERATIONS["road_surface"], 12, 1, 1, "pbf"),
        region_tile_key("landcover", landcover, 12, 1, 1, "png"),
    ]
    _store(*region_keys, "styles/liberty")
    materials = FeatureMaterials(feature_keys=("1-0",), columns={"num_a": np.array([1.0])})
    await feature_material_cache.set_tile_materials(12, 1, 1, materials, value_shape="shape")

    removed = region_tile_cache.discard_region_tiles()

    assert (removed, _kept(*region_keys, "styles/liberty")) == (len(region_keys), {"styles/liberty"})
    assert await feature_material_cache.get_tile_materials(12, 1, 1, value_shape="shape") is None
