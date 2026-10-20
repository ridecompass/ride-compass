"""地理院の標高タイルを、MapLibreの`raster-dem`が読むTerrain-RGBにして配る。

変換後のタイルはキャッシュしない。ネットワークを使うのは変換前のタイルの取得だけで、そちらは
`GsiTileClient`がディスクへ持つ。変換自体はタイル1枚ぶんの配列演算とPNGの書き出しで、
同じものを二重にディスクへ置くだけの価値は無い。
"""

import asyncio

from app.infrastructure.gsi_dem_png import gsi_dem_png_path, gsi_dem_png_to_terrain_rgb
from app.infrastructure.gsi_tile_client import GsiTileClient
from app.infrastructure.http_client import UpstreamNotFound


async def get_terrain_rgb_tile(client: GsiTileClient, z: int, x: int, y: int) -> bytes | UpstreamNotFound | None:
    result = await client.get(gsi_dem_png_path(z, x, y))
    if isinstance(result, UpstreamNotFound) or result is None:
        return result
    content, _ = result
    # 配列演算とPNGの書き出しはCPUを掴む。同時に多数のタイルが来るため、
    # イベントループの外へ逃がす（gsi_tile_client.pyのディスクI/Oと同じ理由）。
    return await asyncio.to_thread(gsi_dem_png_to_terrain_rgb, content)
