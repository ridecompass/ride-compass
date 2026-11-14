"""画面が起動のときに1回取る、再デプロイなしに変わる値の公開読み取りAPI（認可不要）。

どれもビルド時の生成物では配れない——管理APIの書き込みやバッチの作り直しではデプロイが起きないので、生成物に焼くと次の
デプロイまで古い値を配り続ける。
"""

from fastapi import APIRouter, Depends

from app.api.dependencies import get_region_service
from app.domain.road_class_catalog import RoadClassCatalog, road_class_catalog
from app.domain.road_classes import current_road_classes
from app.domain.strict_model import StrictModel
from app.domain.tuning import client_tuning_values
from app.services.region_service import RegionService

router = APIRouter()


class ClientConfigResponse(StrictModel):
    # フロントが使う較正値（id → いま効いている値、`domain/tuning.py`が宣言。作り直しで効く値は作り直しに使った値）。
    client_tuning: dict[str, float]
    # 配信するタイルの世代（系統名 → `<派生の世代>.<生データの世代>-<形の署名>`、`services/tile_version_service.py`）。
    # フロントはこれをタイルURLのクエリへ入れてブラウザのキャッシュを分ける。
    tile_versions: dict[str, str]
    # 事故データの収録年（今の事故の数を数えた取込の宣言そのもの）。地図の説明文が範囲を書くために使う。表示側に文字列で
    # 持つと、取り込み直したときに黙って食い違う。
    accident_years: list[int]
    # 道の区分（`domain/road_class_catalog.py: road_class_catalog`）。
    road_classes: RoadClassCatalog


@router.get("/api/client-config", response_model=ClientConfigResponse)
async def get_client_config(region_service: RegionService = Depends(get_region_service)) -> ClientConfigResponse:
    # 区分と較正値はプロセス内の値。事故の収録年・作り直しで効く較正値・タイルの世代だけがDBを見る。
    return ClientConfigResponse(
        client_tuning={**client_tuning_values(), **await region_service.get_rebuilt_client_tuning()},
        tile_versions=await region_service.tile_versions(),
        accident_years=await region_service.get_accident_years(),
        road_classes=road_class_catalog(current_road_classes()),
    )
