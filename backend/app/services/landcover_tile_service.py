"""土地被覆ラスタタイルの配信。

描画はGDAL側の同期I/Oのため`asyncio.to_thread`へ逃がす（イベントループを止めると、
同時に処理中のルート生成まで詰まる）。
"""

import asyncio

from app.infrastructure import landcover_raster
from app.infrastructure.media_types import PNG_CONTENT_TYPE
from app.infrastructure.region_tile_cache import (
    LANDCOVER_TILE_KIND,
    landcover_generation,
    serve_region_tile,
)

_CATEGORY = "region:landcover-tile"

_EMPTY_TILE = landcover_raster.empty_tile_png()


async def get_landcover_tile(z: int, x: int, y: int) -> bytes:
    """タイル1枚を返す。"""

    async def fetch_tile(_fields: dict) -> bytes | None:
        return await asyncio.to_thread(landcover_raster.render_tile, z, x, y)

    return await serve_region_tile(
        kind=LANDCOVER_TILE_KIND,
        generation=landcover_generation(),
        z=z,
        x=x,
        y=y,
        extension="png",
        empty_tile=_EMPTY_TILE,
        content_type=PNG_CONTENT_TYPE,
        external_call_name=_CATEGORY,
        fetch_tile=fetch_tile,
        source_label="raster",
    )
