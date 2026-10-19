"""道の区分の管理API。区分・地図の線の層・転がり抵抗・除外の設定の全体を1回で読み、1回で書く。

書く全体の形の良し悪しは表の制約だけが決め、通らなければ409でDBの断りの文を返す（`services/road_class_service.py`）。
"""

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.admin_auth import require_admin_basic_auth
from app.api.dependencies import get_road_class_admin_service
from app.domain.road_classes import RoadClassDefinitions
from app.services.road_class_service import RoadClassAdminService, RoadClassRejectedError

router = APIRouter(
    prefix="/api/admin/road-classes", tags=["road-class-admin"], dependencies=[Depends(require_admin_basic_auth)]
)


@router.get("", response_model=RoadClassDefinitions)
async def read_road_classes(service: RoadClassAdminService = Depends(get_road_class_admin_service)) -> RoadClassDefinitions:
    return await service.read()


@router.put("", response_model=RoadClassDefinitions)
async def replace_road_classes(
    definitions: RoadClassDefinitions,
    service: RoadClassAdminService = Depends(get_road_class_admin_service),
) -> RoadClassDefinitions:
    try:
        return await service.replace(definitions)
    except RoadClassRejectedError as error:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"表の制約に通りません: {error}") from error
