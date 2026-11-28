"""ひな形の管理API。ひな形の全体を1回で読み、1回で書く。

書く全体を断ったら（今の費用の軸・道の段の行に無い名を指す）、409で断りの文を返す。まだ1つも無ければ、読むと空の全体。
"""

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.admin_auth import require_admin_basic_auth
from app.api.dependencies import get_route_profile_admin_service
from app.domain.route_profiles import RouteProfiles
from app.services.route_profile_service import RouteProfileAdminService, RouteProfilesRejectedError

router = APIRouter(
    prefix="/api/admin/route-profiles", tags=["route-profile-admin"], dependencies=[Depends(require_admin_basic_auth)]
)


@router.get("", response_model=RouteProfiles)
async def read_route_profiles(
    service: RouteProfileAdminService = Depends(get_route_profile_admin_service),
) -> RouteProfiles:
    return await service.read()


@router.put("", response_model=RouteProfiles)
async def replace_route_profiles(
    profiles: RouteProfiles,
    service: RouteProfileAdminService = Depends(get_route_profile_admin_service),
) -> RouteProfiles:
    try:
        return await service.replace(profiles)
    except RouteProfilesRejectedError as error:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(error)) from error
