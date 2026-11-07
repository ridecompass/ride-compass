import asyncio
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import Field, model_validator

from app.api.dependencies import (
    get_road_inspector_service,
    LandcoverTileReader,
    get_feature_material_service,
    get_landcover_tile_reader,
    get_lens_service,
    get_region_service,
)
from app.api.rate_limit import enforce_rate_limit
from app.api.routers._tile_http import (
    check_tile_rate_limit,
    region_tile_semaphore,
    tile_response,
    validate_tile_coords,
)
from app.api.routers.cost_axis_catalog import cost_preference_query
from app.config import settings
from app.domain.lens_values import RoadInspection
from app.domain.cost_preference import CostPreference, RequestedCostPreference
from app.domain.geo import BearingDeg
from app.domain.route_request import AssumedSpeedKmh
from app.domain.landcover import LandcoverTileZoom
from app.domain.geo import Latitude, Longitude
from app.domain.region import RoadAt, RoadsAtRadiusM, RoadTileZoom, TileIndex, check_tile_index
from app.infrastructure.media_types import PNG_CONTENT_TYPE
from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS
from app.services.feature_materials import FeatureMaterialService
from app.services.lens_service import LensService
from app.services.region_service import RegionService, RoadInspectorService
from app.domain.strict_model import StrictModel

router = APIRouter()

# 土地被覆タイルの同時実行上限。DBではなくGeoTIFFの読み取り・再投影（GDAL、スレッドプール）を
# 使うため、DB向けの`_tile_http.py: region_tile_semaphore`とは別に持つ。上限を設けないと、1画面ぶんのタイル要求が
# `asyncio.to_thread`の既定スレッドプールを占有し、同じプールを使う他のディスクI/O
# （タイルキャッシュの読み書き）まで待たされる。
_landcover_tile_semaphore = asyncio.Semaphore(settings.landcover_tile_max_concurrent)


@router.get("/api/region/road-surface-tiles/{z}/{x}/{y}.pbf")
async def region_road_surface_tile(
    z: RoadTileZoom,
    x: TileIndex,
    y: TileIndex,
    request: Request,
    region_service: RegionService = Depends(get_region_service),
) -> Response:
    check_tile_rate_limit(request, "road-tile")
    validate_tile_coords(z, x, y)
    # 上限を超えた分は429にせず待たせる。キャッシュヒットはすぐ解放するので、待ち行列を作るのはPostGIS問い合わせを伴う要求だけ。
    async with region_tile_semaphore:
        tile = await region_service.get_road_surface_tile(z, x, y)
    return tile_response(tile)


@router.get("/api/region/point-tiles/{layer}/{z}/{x}/{y}.pbf")
async def region_point_tile(
    layer: str,
    z: RoadTileZoom,
    x: TileIndex,
    y: TileIndex,
    request: Request,
    region_service: RegionService = Depends(get_region_service),
) -> Response:
    """点のレイヤー（`infrastructure/point_tile_layers.py`の名前。例: 停止要因・補給休憩のPOI、事故）。
    宣言に無いレイヤーは404。路面タイルと同じ歯止め・同時実行制御を使い、レート制限のキーはレイヤーごとに分ける。
    """
    point_layer = POINT_TILE_LAYERS.get(layer)
    if point_layer is None:
        raise HTTPException(status_code=404, detail="指定された地点のレイヤーはありません。")
    check_tile_rate_limit(request, f"{layer}-tile")
    validate_tile_coords(z, x, y)
    async with region_tile_semaphore:
        tile = await region_service.get_point_tile(point_layer, z, x, y)
    return tile_response(tile)


@router.get("/api/region/landcover-tiles/{z}/{x}/{y}.png")
async def region_landcover_tile(
    z: LandcoverTileZoom,
    x: TileIndex,
    y: TileIndex,
    request: Request,
    read_tile: LandcoverTileReader = Depends(get_landcover_tile_reader),
) -> Response:
    """土地被覆ラスタ（Esri×Impact Observatory 10m LULC）をそのまま面で塗ったラスタタイル。

    DBを読まないため`region_tile_semaphore`（DB接続プールの取り合いを抑えるもの）には
    乗せず、CPU/ディスクI/Oの上限は`landcover_tile_max_concurrent`の専用semaphoreで持つ。
    """
    check_tile_rate_limit(request, "landcover-tile")
    validate_tile_coords(z, x, y)
    async with _landcover_tile_semaphore:
        tile = await read_tile(z, x, y)
    return tile_response(tile, PNG_CONTENT_TYPE)


@router.get("/api/region/lens/{lens_id}/{z}/{x}/{y}")
async def region_lens(
    lens_id: str,
    z: RoadTileZoom,
    x: TileIndex,
    y: TileIndex,
    request: Request,
    speed_kmh: AssumedSpeedKmh,
    at: datetime | None = None,
    preference: CostPreference = Depends(cost_preference_query),
    service: LensService = Depends(get_lens_service),
) -> dict[str, dict[str, float]]:
    """ルートを出す前の地図がレンズ`lens_id`（総合`total`か費用の軸のid。`domain/lens_values.py`）で道を塗る、指定タイルの
    フィーチャーごとの道ごとの材料: 道の向きに辿った・逆向きに辿った1kmあたりの代償の秒（辿れない向きは載せない）と、
    道の向き。どちらの向きを塗るかは、`/api/cost-axes`の`map_lens.formula`が走行方位で選ぶ。値は時刻`at`（省略すると今。
    風）と想定速度`speed_kmh`と利用者の値（つまみ`strength`と、軸id→倍率のJSONの`multipliers`。ルート生成と同じ値）で決まり、
    探索と同じ部品で求める。

    鍵は路面タイル（`/api/region/road-surface-tiles`）の同じz/x/yのフィーチャーの鍵。知らないレンズは404。
    """
    check_tile_rate_limit(request, "lens")
    validate_tile_coords(z, x, y)
    async with region_tile_semaphore:
        materials = await service.way_materials(lens_id, z, x, y, at, speed_kmh, preference)
    if materials is None:
        raise HTTPException(status_code=404, detail="この負担の種類の値はありません。")
    return materials


@router.get("/api/region/road-classes/{z}/{x}/{y}")
async def region_road_classes(
    z: RoadTileZoom,
    x: TileIndex,
    y: TileIndex,
    request: Request,
    service: FeatureMaterialService = Depends(get_feature_material_service),
) -> dict[str, dict[str, str]]:
    """地図の道の線を塗る、指定タイル内のフィーチャーごとの層の値（画面の設定の`road_classes.map_layers`の`id`→値）。鍵は路面タイルの
    `feature_key`。値は区分の鍵か「データなし」（`domain/road_classes.py: NO_DATA_VALUE`）で、区分の外の道の層は載せない。
    ルートの区間の帯も同じ値を持つ。"""
    check_tile_rate_limit(request, "road-classes")
    validate_tile_coords(z, x, y)
    async with region_tile_semaphore:
        return await service.road_layer_values(z, x, y)


class RoadInspectorRequest(StrictModel):
    osm_way_id: int
    # クリックされたフィーチャーの識別子（路面タイルが焼く`feature_key`）。区間で焼くズームでは区間、道1本で焼くズームでは道1本を指す。
    feature_key: str
    # 押したタイル。地図は既に知っており、way idから逆算するより確かで、地図のレンズと同じタイルの組み立てで値を求められる。
    z: RoadTileZoom
    x: TileIndex
    y: TileIndex
    # レンズの値は向き・時刻（風）・速さで決まる。地図のレンズの要求と同じ値を送る（省いた時刻は今）。**1本の道は往復
    # 2方向で値が違う**ので、両方の向きを返し、地図がいまの走行方位で塗っている向きを示す。
    bearing_deg: BearingDeg
    at: datetime | None = None
    speed_kmh: AssumedSpeedKmh
    # 利用者の値。ルート生成へ送るのと同じ形・同じ検証。地図のレンズの要求と同じ値を送る。
    cost_preference: RequestedCostPreference = Field(default_factory=CostPreference)

    @model_validator(mode="after")
    def _check_tile_index(self) -> "RoadInspectorRequest":
        check_tile_index(self.z, self.x, self.y)
        return self


class RoadsAtRequest(StrictModel):
    longitude: Longitude
    latitude: Latitude
    # 地図の今の倍率を、路面タイルのズームへ丸めた値。返す道の単位（区間か道1本か）をタイルと同じにする。
    z: RoadTileZoom
    # 拾う距離。地図が指の幅を今の倍率で m に直して送る。
    radius_m: RoadsAtRadiusM


@router.post("/api/region/roads-at")
async def region_roads_at(
    body: RoadsAtRequest,
    http_request: Request,
    region_service: RegionService = Depends(get_region_service),
) -> list[RoadAt]:
    """押した所に近い道のフィーチャー（近い順）。プロパティはズーム`z`の路面タイルと同じで、地図は道のタイルを読まずに
    道の小窓を開ける。押した位置を URL に残さないよう POST で受ける。"""
    enforce_rate_limit(http_request, "roads-at", settings.roads_at_rate_limit_per_minute)
    return await region_service.roads_at(body.longitude, body.latitude, body.z, body.radius_m)


@router.post("/api/region/road-inspector")
async def region_road_inspector(
    body: RoadInspectorRequest,
    http_request: Request,
    road_inspector: RoadInspectorService = Depends(get_road_inspector_service),
) -> RoadInspection | None:
    """道の窓。押した道（osm_way_id）の一次属性（highway/tags）と、押したフィーチャー（その倍率で地図が塗る区間か道1本）の
    レンズの値（地図のレンズ`/api/region/lens`と同じ値を両方の向きで）。道はosm_way_idの完全一致で引く（交差点付近での
    取り違え対策）。見つからなければnull。
    """
    # 道を押すたびの単発リクエストなので、タイル向けの上限を流用せず専用の上限を使う。
    enforce_rate_limit(http_request, "road-inspector", settings.road_inspector_rate_limit_per_minute)
    return await road_inspector.inspect(
        body.osm_way_id, body.feature_key, (body.z, body.x, body.y), body.bearing_deg, body.at, body.speed_kmh,
        body.cost_preference,
    )
