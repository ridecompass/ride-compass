from fastapi import APIRouter, Depends, Request, Response

from app.api.dependencies import get_gsi_tile_client
from app.api.rate_limit import enforce_rate_limit
from app.api.routers._tile_http import GSI_TILE_REPLIES, validate_tile_coords
from app.config import settings
from app.infrastructure.gsi_tile_client import GsiTileClient
from app.domain.gsi_tiles import RELIEF_UPSTREAM_PATH, TerrainTileZoom
from app.domain.region import TileIndex
from app.infrastructure.media_types import PNG_CONTENT_TYPE
from app.services.terrain_tile_service import get_terrain_rgb_tile

router = APIRouter()

_RELIEF_PREFIX = "/api/gsi-relief-tile"
#: 色別標高図は上流のパスをそのまま中継する。
_RELIEF_ROUTE = f"{_RELIEF_PREFIX}/{{path:path}}"
#: 画面が要求するURL（生成物で届く）。ルートの接頭辞と上流のパスから決まる（別々に書かない）。
RELIEF_TILE_URL = f"{_RELIEF_PREFIX}/{RELIEF_UPSTREAM_PATH}"
#: 標高タイルは変換して配るため、上流のパスではなく自前のルートを持ち、それが画面の要求するURLになる。
TERRAIN_TILE_URL = "/api/gsi-terrain-tile/{z}/{x}/{y}.png"


@router.get(_RELIEF_ROUTE)
async def gsi_relief_tile_proxy(
    path: str, request: Request, gsi_tile_client: GsiTileClient = Depends(get_gsi_tile_client)
) -> Response:
    # 認証なしで叩けるプロキシへの簡易な歯止め。
    enforce_rate_limit(request, "gsi-relief-tile", settings.gsi_tile_rate_limit_per_minute)
    content, content_type = GSI_TILE_REPLIES.found(await gsi_tile_client.get(path, category="gsi:relief-tile"))
    return Response(content=content, media_type=content_type)


@router.get(TERRAIN_TILE_URL)
async def gsi_terrain_tile(
    z: TerrainTileZoom,
    x: TileIndex,
    y: TileIndex,
    request: Request,
    gsi_tile_client: GsiTileClient = Depends(get_gsi_tile_client),
) -> Response:
    """地理院の標高タイルをTerrain-RGBへ移して返す（MapLibreの`raster-dem`が読む形）。

    整備区域外の404は上のプロキシと同じく正常系。MapLibreはそのタイルの陰影を描かないだけで、
    地図全体は成立する。
    """
    enforce_rate_limit(request, "gsi-terrain-tile", settings.gsi_tile_rate_limit_per_minute)
    validate_tile_coords(z, x, y)
    content = GSI_TILE_REPLIES.found(await get_terrain_rgb_tile(gsi_tile_client, z, x, y))
    return Response(content=content, media_type=PNG_CONTENT_TYPE)
