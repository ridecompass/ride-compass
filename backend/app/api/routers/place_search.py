"""地点の検索（`GET /api/place-search`）と、置いた位置の辺り（`GET /api/place-area`）と、施設を外の地図で開く転送
（`GET /api/place-link`）。"""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse

from app.api.cache_policy import MASTER_LOOKUP
from app.api.dependencies import get_place_search_service
from app.api.rate_limit import enforce_rate_limit
from app.config import settings
from app.domain.geo import Latitude, LatLonPoint, Longitude
from app.domain.place_search import PlaceArea, PlaceLinkName, PlaceQuery, PlaceSearchResult
from app.services.place_search_service import PlaceSearchAreaUnavailable, PlaceSearchService

router = APIRouter()


@router.get("/api/place-search", response_model=PlaceSearchResult)
async def search_places(
    http_request: Request,
    q: PlaceQuery,
    latitude: Latitude,
    longitude: Longitude,
    service: PlaceSearchService = Depends(get_place_search_service),
) -> PlaceSearchResult:
    """入力した文字列に当たる地点の候補（対象範囲の中だけ）。住所と施設は`latitude`・`longitude`（画面が見ている所の
    真ん中）に近いものを先に並べる。何も当たらなければ空の並び。対象範囲を読めなければ502。"""
    enforce_rate_limit(http_request, "place-search", settings.place_search_rate_limit_per_minute)
    try:
        return await service.search(q, LatLonPoint(latitude, longitude))
    except PlaceSearchAreaUnavailable:
        raise HTTPException(status_code=502, detail="対象範囲を読めませんでした") from None


@router.get("/api/place-area", response_model=PlaceArea)
async def place_area(
    http_request: Request,
    latitude: Latitude,
    longitude: Longitude,
    service: PlaceSearchService = Depends(get_place_search_service),
) -> PlaceArea:
    """位置の辺り（市区町村から字・丁目まで）。名前を持つ小地域の境界に含まれなければ`area`が空。"""
    enforce_rate_limit(http_request, "place-area", settings.place_area_rate_limit_per_minute)
    return await service.area_at(LatLonPoint(latitude, longitude))


@router.get("/api/place-link", response_class=RedirectResponse, status_code=302)
async def place_link(
    http_request: Request,
    name: PlaceLinkName,
    latitude: Latitude,
    longitude: Longitude,
    service: PlaceSearchService = Depends(get_place_search_service),
) -> RedirectResponse:
    """施設（名前`name`・位置）を外の地図（Google マップ）で開く302の転送。画面は普通のリンクでここを開くので、押してから
    外の地図を開くまでに画面が待たない（待ちを挟んで新しいタブを開くと、ブラウザが止めることがある）。"""
    enforce_rate_limit(http_request, "place-link", settings.place_link_rate_limit_per_minute)
    url = await service.external_map_url(name, LatLonPoint(latitude, longitude))
    # 転送（302）には`CachePolicyMiddleware`が付けないので、ここで付ける。
    return RedirectResponse(url, status_code=302, headers={"Cache-Control": MASTER_LOOKUP.header()})
