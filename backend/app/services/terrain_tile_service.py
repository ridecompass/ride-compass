"""地理院の標高タイルを、MapLibreの`raster-dem`が読むTerrain-RGBにして配る。

**画素は道の標高と同じ製品の並びで埋める**（`domain/gsi_tiles.py: PRODUCT_PRIORITY`。DEM5A→DEM5B→DEM5C→DEM10B）——上の製品の
タイルに値の無い画素がある間だけ、次の製品のタイルを読んで埋める。欠けの無い所が読むのは1枚。製品の上限より細かいズームでは、
その製品の上限のズームのタイルの、そのタイルに当たる部分を引き伸ばして使う。どの製品にも値の無い画素は海抜0mにする
（`infrastructure/gsi_dem_png.py`）。DB の標高タイルを点で引く`infrastructure/dem_elevation.py: fill_elevations`へは寄せない
——読む元が配信元の PNG で、1枚のタイルの全画素を配列で重ねるため。配信元の陰影起伏図も、精度の良い製品から順に重ねて作られている
（https://maps.gsi.go.jp/development/ichiran.html の陰影起伏図の欄）。

変換後のタイルはキャッシュしない。ネットワークを使うのは変換前のタイルの取得だけで、そちらは
`GsiTileClient`がディスクへ持つ。変換自体はタイル数枚ぶんの配列演算とPNGの書き出しで、
同じものを二重にディスクへ置くだけの価値は無い。
"""

import asyncio

import numpy as np
from PIL import Image

from app.domain.gsi_tiles import DEM_PRODUCT_MAX_ZOOM
from app.infrastructure.gsi_dem_png import gsi_dem_png_path, read_gsi_dem_png, terrain_rgb_png
from app.infrastructure.gsi_tile_client import GsiTileClient
from app.infrastructure.http_client import UPSTREAM_NOT_FOUND, UpstreamNotFound


def _grid(png: bytes, z: int, x: int, y: int, zoom: int) -> tuple[np.ndarray, np.ndarray]:
    """ズーム`zoom`のタイル1枚の格子から、ズーム`z`のタイル(`x`, `y`)に当たる部分を、タイルの大きさへ双一次の補間で
    引き伸ばして返す（画素を同じ値で並べて引き伸ばすと、陰影が画素の境で段になる）。値の無い画素が補間に混ざる画素は、
    値が無いとする。"""
    signed, missing = read_gsi_dem_png(png)
    scale = 1 << (z - zoom)
    if scale == 1:
        return signed, missing
    size = signed.shape[0] // scale
    row, column = (y % scale) * size, (x % scale) * size
    part = (slice(row, row + size), slice(column, column + size))
    full = signed.shape[::-1]

    def stretched(grid: np.ndarray) -> np.ndarray:
        return np.asarray(Image.fromarray(grid.astype(np.float32), mode="F").resize(full, Image.Resampling.BILINEAR))

    values = stretched(np.where(missing[part], 0, signed[part]))
    return np.rint(values).astype(np.int64), stretched(missing[part]) > 0


async def get_terrain_rgb_tile(client: GsiTileClient, z: int, x: int, y: int) -> bytes | UpstreamNotFound:
    signed: np.ndarray | None = None
    missing: np.ndarray | None = None
    for product, max_zoom in DEM_PRODUCT_MAX_ZOOM.items():
        if missing is not None and not missing.any():
            break
        zoom = min(z, max_zoom)
        shift = z - zoom
        result = await client.get(gsi_dem_png_path(product, zoom, x >> shift, y >> shift))
        if isinstance(result, UpstreamNotFound):  # その製品の整備区域の外
            continue
        # 配列演算はCPUを掴む。同時に多数のタイルが来るため、イベントループの外へ逃がす（gsi_tile_client.pyのディスクI/Oと同じ理由）。
        values, absent = await asyncio.to_thread(_grid, result[0], z, x, y, zoom)
        if signed is None or missing is None:
            signed, missing = values, absent
        else:
            signed = np.where(missing & ~absent, values, signed)
            missing = missing & absent
    if signed is None or missing is None:
        return UPSTREAM_NOT_FOUND
    return await asyncio.to_thread(terrain_rgb_png, signed, missing)
