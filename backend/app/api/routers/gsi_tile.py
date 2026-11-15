from fastapi import APIRouter, Depends, Request, Response

from app.api.dependencies import get_gsi_tile_client
from app.api.rate_limit import enforce_rate_limit
from app.api.routers._tile_http import GSI_TILE_REPLIES, validate_tile_coords
from app.config import settings
from app.infrastructure.gsi_tile_client import GsiTileClient
from app.domain.gsi_tiles import TerrainTileZoom
from app.domain.region import TileIndex
from app.infrastructure.media_types import PNG_CONTENT_TYPE
from app.services.terrain_tile_service import get_terrain_rgb_tile

router = APIRouter()

#: 標高タイルは変換して配るため、自前のルートを持ち、それが画面の要求するURLになる（生成物で届く）。
TERRAIN_TILE_URL = "/api/gsi-terrain-tile/{z}/{x}/{y}.png"


@router.get(TERRAIN_TILE_URL)
async def gsi_terrain_tile(
    z: TerrainTileZoom,
    x: TileIndex,
    y: TileIndex,
    request: Request,
    gsi_tile_client: GsiTileClient = Depends(get_gsi_tile_client),
) -> Response:
    """地理院の標高タイルをTerrain-RGBへ移して返す（MapLibreの`raster-dem`が読む形）。

    整備区域外の404は正常系。MapLibreはそのタイルの陰影を描かないだけで、
    地図全体は成立する。
    """
    enforce_rate_limit(request, "gsi-terrain-tile", settings.gsi_tile_rate_limit_per_minute)
    validate_tile_coords(z, x, y)
    content = GSI_TILE_REPLIES.found(await get_terrain_rgb_tile(gsi_tile_client, z, x, y))
    return Response(content=content, media_type=PNG_CONTENT_TYPE)
