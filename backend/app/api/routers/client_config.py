"""画面が起動のときに1回取る、再デプロイなしに変わる値の公開読み取りAPI（認可不要）。

どれもビルド時の生成物では配れない——管理APIの書き込みやバッチの作り直しではデプロイが起きないので、生成物に焼くと次の
デプロイまで古い値を配り続ける。
"""

from fastapi import APIRouter, Depends

from app.api.dependencies import get_region_service
from app.services.region_service import ClientConfigResponse, RegionService

router = APIRouter()


@router.get("/api/client-config", response_model=ClientConfigResponse)
async def get_client_config(region_service: RegionService = Depends(get_region_service)) -> ClientConfigResponse:
    return await region_service.get_client_config()
