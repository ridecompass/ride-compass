import asyncio
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import model_validator

from app.api.dependencies import (
    LandcoverTileReader,
    get_axis_inspector_service,
    get_dedicated_way_value_service,
    get_landcover_tile_reader,
    get_region_service,
)
from app.api.rate_limit import enforce_rate_limit
from app.api.routers._tile_http import tile_response, validate_tile_coords
from app.api.routers.routes import RoutePreferenceWeights
from app.config import settings
from app.domain.dynamic_way_values import WayValueQuery
from app.domain.axis_inspector import AxisInspectorResult
from app.domain.geo import BearingDeg
from app.domain.route_request import AssumedSpeedKmh
from app.domain.landcover import LandcoverTileZoom
from app.domain.region import RoadTileZoom, TileIndex, check_tile_index
from app.domain.route import Coordinates
from app.infrastructure.media_types import PNG_CONTENT_TYPE
from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS
from app.services.dedicated_way_values import AxisWayValueLens
from app.services.region_service import AxisInspectorService, RegionService
from app.domain.strict_model import StrictModel

router = APIRouter()

# 地域タイル（路面・点）の同時実行上限
# （settings.road_tile_max_concurrent、値の根拠はconfig.py参照）。
#
# 上限超過分は即座に429を返すルート生成とは異なり、こちらは「待たせて全件処理する」
# （semaphoreの取得をブロックさせる）方式にしている。MapLibreは失敗したタイル要求を
# 自動再試行しないため、429にすると1画面に収まる範囲で上限を超えるタイル（皇居周辺のような
# 広い範囲では珍しくない）が永久に空白のまま描画されなくなる（詳細は
# docs/modules/backend/static-road-attributes.md参照）。/healthはこのsemaphoreを
# 経由しない別の同期ハンドラのため、待機中のタイル要求に巻き込まれず応答し続けられる。
#
# 点のタイルも同じDB接続プールを取り合うため、専用semaphoreを新設せずこれを
# 共有する（プール上限15接続に対し、独立semaphoreを追加すると種類ごとのタイルの同時実行数の
# 合計がプール上限を超えうる）。
_region_tile_semaphore = asyncio.Semaphore(settings.road_tile_max_concurrent)

# 土地被覆タイルの同時実行上限。DBではなくGeoTIFFの読み取り・再投影（GDAL、スレッドプール）を
# 使うため、上のDB向けsemaphoreとは別に持つ。上限を設けないと、1画面ぶんのタイル要求が
# `asyncio.to_thread`の既定スレッドプールを占有し、同じプールを使う他のディスクI/O
# （タイルキャッシュの読み書き）まで待たされる。
_landcover_tile_semaphore = asyncio.Semaphore(settings.landcover_tile_max_concurrent)


def _check_tile_rate_limit(request: Request, prefix: str) -> None:
    """地域タイル向けの`enforce_rate_limit`の薄いラッパー。どれも「パン/ズームのたびに
    1画面ぶんが飛ぶ」同じ負荷の形のため同じ上限値（settings.road_tile_rate_limit_per_minute）
    を使うが、キー・記録先の`prefix`は種別ごとに分ける。
    """
    enforce_rate_limit(request, prefix, settings.road_tile_rate_limit_per_minute)


@router.get("/api/region/road-surface-tiles/{z}/{x}/{y}.pbf")
async def region_road_surface_tile(
    z: RoadTileZoom,
    x: TileIndex,
    y: TileIndex,
    request: Request,
    region_service: RegionService = Depends(get_region_service),
) -> Response:
    _check_tile_rate_limit(request, "road-tile")
    validate_tile_coords(z, x, y)
    # 同時実行数の上限（_region_tile_semaphoreのコメント参照）は、超過分を待たせて
    # 全件処理する（即座に429で拒否しない）。キャッシュヒットは軽量（実測数ms）なので
    # すぐ解放され、実質的に重い（PostGIS問い合わせを伴う）リクエストだけが待ち行列の
    # 原因になる。
    async with _region_tile_semaphore:
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
        raise HTTPException(status_code=404, detail="未知の点のレイヤーです。")
    _check_tile_rate_limit(request, f"{layer}-tile")
    validate_tile_coords(z, x, y)
    async with _region_tile_semaphore:
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

    DBを読まないため`_region_tile_semaphore`（DB接続プールの取り合いを抑えるもの）には
    乗せず、CPU/ディスクI/Oの上限は`landcover_tile_max_concurrent`の専用semaphoreで持つ。
    """
    _check_tile_rate_limit(request, "landcover-tile")
    validate_tile_coords(z, x, y)
    async with _landcover_tile_semaphore:
        tile = await read_tile(z, x, y)
    if tile is None:
        raise HTTPException(status_code=503, detail="土地被覆データが利用できません")
    return tile_response(tile, PNG_CONTENT_TYPE)


@router.get("/api/region/way-materials/{axis_id}/{z}/{x}/{y}")
async def region_way_materials(
    axis_id: str,
    z: RoadTileZoom,
    x: TileIndex,
    y: TileIndex,
    request: Request,
    at: datetime | None = None,
    lens: AxisWayValueLens | None = Depends(get_dedicated_way_value_service),
) -> dict[str, dict[str, float]]:
    """ルート未確定時の地図が、公開軸の値を走行方位・想定速度から自分で求めるための、指定タイル内のフィーチャーごとの
    道ごとの材料（材料の名前→値。値の無い材料は載せない）。値は軸カタログの木（`way_value_formula`）へ、走る条件
    （`bearing_deg`・`speed_kmh`）とともに入れると、探索と同じ評価の値（区間インスペクタの得点と同じ値）になる
    （`services/dedicated_way_values.py: tile_axis_way_materials`）。ルート確定後はルート自身の`axis_difficulties`
    （`RouteSegmentDetail`）で塗るため、この口を呼ばない。

    パスパラメータは**軸id**（`axis_definitions.axis_id`）で、材料id（`wind_drag_ratio`等）とは別の名前空間である。
    応答は走行方位・想定速度に依らず、受け取らない。時刻（`at`）は時刻に依る材料（風）の時刻で、省略すると現在時刻
    [Asia/Tokyo]。公開軸でないaxis_idと、木の無い軸（軸カタログの`way_value_formula`がnull）は404。

    静的な路面タイル（`/api/region/road-surface-tiles`、MVT）とは別経路——受け取る側は同じz/x/yについて両方を取り、
    フィーチャーの鍵で突き合わせて重ねる。タイルの材料と勾配の道ごとの材料はタイル単位でディスクへ持つため、パン・
    ズームで同じタイルが再び視界に入っても、DBへの再問い合わせは発生しない（風は計算が軽いため持たない）。
    路面・点のタイルと同じレート制限・座標検証・DB接続プールのsemaphoreを共有する（MVTエンコードは伴わないが、
    同じPostGISコネクションプールを取り合うため）。
    """
    if lens is None:
        raise HTTPException(status_code=404, detail="公開している軸ではありません。")
    _check_tile_rate_limit(request, f"{axis_id}-way-materials")
    validate_tile_coords(z, x, y)
    async with _region_tile_semaphore:
        materials = await lens.way_materials(z, x, y, at)
    if materials is None:
        raise HTTPException(status_code=404, detail="この軸は道ごとの材料を配りません。")
    return materials


class AxisInspectorRequest(StrictModel):
    osm_way_id: int
    # クリックされたフィーチャーの識別子（路面タイルが焼く`feature_key`）。区間で焼くズームでは押した区間を指す。
    feature_key: str
    # クリックした地点。道1本で焼くズームで押したときに、その道のうち地点に最も近い区間を選ぶ。
    point: Coordinates
    # 進行方向に依存する材料（勾配・風）を出すのに要るもの。**1本の道は往復2方向で値が
    # 違う**ため、方向が決まらないと算出できない。地図が指定している値をそのまま送る
    # （地図が式の木へ入れている向き・速度と同じ）。時刻・速度を省くと、それを要る材料の軸は「データなし」。
    # `z`/`x`/`y`はクリックしたタイル——地図は既に知っており、way idから逆算するより
    # 確かで、同じタイルの値がキャッシュに載っていれば追加のDBアクセスも要らない。
    z: RoadTileZoom
    x: TileIndex
    y: TileIndex
    bearing_deg: BearingDeg
    at: datetime | None = None
    speed_kmh: AssumedSpeedKmh | None = None
    # 合成に使う重み。利用者がいま設定している重み（ルート生成へ送るのと同じ形・同じ検証）を送る。省略すると既定の重み。
    route_preference: RoutePreferenceWeights | None = None

    @model_validator(mode="after")
    def _check_tile_index(self) -> "AxisInspectorRequest":
        check_tile_index(self.z, self.x, self.y)
        return self


@router.post("/api/region/axis-inspector")
async def region_axis_inspector(
    body: AxisInspectorRequest,
    http_request: Request,
    axis_inspector: AxisInspectorService = Depends(get_axis_inspector_service),
) -> AxisInspectorResult | None:
    """区間インスペクタ。クリックされた道路（osm_way_id）について、一次属性（highway/tags）と、押した区間・その区間を
    含む道1本それぞれの軸の得点（地図がそれぞれを塗る値と同じ評価）・合成（取得可能な軸だけの参考値。重みは送られた
    `route_preference`、省略時は既定）を返す。道はosm_way_idの完全一致で引く（交差点付近での取り違え対策）。
    進行方向に依存する軸（勾配・風）は、地図が指定している走行方位・時刻・想定速度から算出する。時刻・速度を
    送らなければ、それを要る軸は得点がnullで返る。
    """
    # 道を押すたびの単発リクエストのためタイル向け_check_tile_rate_limit
    # （road_tile_rate_limit_per_minuteと結合）を流用せず、専用の設定値を直接使う
    # （config.py: axis_inspector_rate_limit_per_minuteのコメント参照）。
    enforce_rate_limit(http_request, "axis-inspector", settings.axis_inspector_rate_limit_per_minute)
    preference = None if body.route_preference is None else body.route_preference.to_preference()
    return await axis_inspector.inspect(
        body.osm_way_id, body.feature_key, body.z, body.x, body.y, body.point,
        WayValueQuery(at=body.at, bearing_deg=body.bearing_deg, speed_kmh=body.speed_kmh), preference)
