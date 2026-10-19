"""道の区分の群の管理API。

`domain/road_classes.py`のプロセス内の群をDBの内容と同期させる書き込み口で、認可を要求する。群は丸ごと読み書きし、
本文の検査（道の事実の名前と値の型・行の鍵の重なり）は`domain/road_classes.py: RoadClassGroup`が、
公開した群を守る検査はサービスが持つ。
"""

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.admin_auth import require_admin_basic_auth
from app.api.dependencies import get_road_class_admin_service
from app.domain.road_classes import RoadClassGroup
from app.services.road_class_service import RoadClassAdminService

router = APIRouter(
    prefix="/api/admin/road-classes", tags=["road-class-admin"], dependencies=[Depends(require_admin_basic_auth)]
)


def _group_not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="この群はもうありません（ほかで削除された可能性があります）。一覧を読み直してください。",
    )


@router.get("")
async def list_road_class_groups(
    service: RoadClassAdminService = Depends(get_road_class_admin_service),
) -> list[RoadClassGroup]:
    return list((await service.list_all()).values())


@router.put("/{group_key}")
async def put_road_class_group(
    group_key: str, payload: RoadClassGroup, service: RoadClassAdminService = Depends(get_road_class_admin_service)
) -> RoadClassGroup:
    if payload.group_key != group_key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="group_keyはURLとボディで一致させてください")
    try:
        await service.put(payload)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return payload


@router.delete("/{group_key}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_road_class_group(
    group_key: str, service: RoadClassAdminService = Depends(get_road_class_admin_service)
) -> None:
    try:
        await service.delete(group_key)
    except KeyError as exc:
        raise _group_not_found() from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
