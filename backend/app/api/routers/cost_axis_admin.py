"""費用の軸の定義の管理API。体力の軸の見せ方と道のストレスの軸の全体を1回で読み、1回で書く。

書く全体を断ったら（材料・区分に照らして通らない）、409で断りの文を返す。まだ全体が無ければ、読むと404。
"""

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.admin_auth import require_admin_basic_auth
from app.api.dependencies import get_cost_axis_admin_service
from app.domain.cost_axes import CostAxisDefinitions
from app.services.cost_axis_service import CostAxesRejectedError, CostAxisAdminService

router = APIRouter(
    prefix="/api/admin/cost-axes", tags=["cost-axis-admin"], dependencies=[Depends(require_admin_basic_auth)]
)


@router.get("", response_model=CostAxisDefinitions)
async def read_cost_axes(
    service: CostAxisAdminService = Depends(get_cost_axis_admin_service),
) -> CostAxisDefinitions:
    definitions = await service.read()
    if definitions is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="費用の軸の定義はまだありません")
    return definitions


@router.put("", response_model=CostAxisDefinitions)
async def replace_cost_axes(
    definitions: CostAxisDefinitions,
    service: CostAxisAdminService = Depends(get_cost_axis_admin_service),
) -> CostAxisDefinitions:
    try:
        return await service.replace(definitions)
    except CostAxesRejectedError as error:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(error)) from error
