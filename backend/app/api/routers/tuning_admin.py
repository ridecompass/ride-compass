"""較正値の管理API（`domain/tuning.py`の宣言といま効いている値を読み、値を書く）。

走行モデルの振る舞いを直接変えられるため、ほかの管理APIと同じ認可境界の内側に置く
（`require_admin_basic_auth`）。

**画面が並べる項目はこのAPIが宣言から導く**。較正値を1つ足しても、ここと画面の両方へ
書き足す場所は無い（`TUNING_PARAMETERS`に載っているものだけを返す——較正値ではない固定値は
使う側のモジュールに置いたままで、このAPIからは見えない（物理定数を出すと模型を壊せ、
資源の上限を出すと本番を止められる）。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from app.api.admin_auth import require_admin_basic_auth
from app.api.dependencies import get_tuning_service
from app.domain.strict_model import StrictModel
from app.domain.tuning import TUNING_PARAMETERS_BY_ID
from app.domain.tuning_labels import TuningParameterView, tuning_parameter_view, tuning_parameter_views
from app.services.tuning_service import TuningService

router = APIRouter(prefix="/api/admin/tuning", tags=["tuning-admin"], dependencies=[Depends(require_admin_basic_auth)])


class TuningUpdateRequest(StrictModel):
    """1件の値。"""

    value: float


@router.get("", response_model=list[TuningParameterView])
async def list_tuning_parameters() -> list[TuningParameterView]:
    return tuning_parameter_views()


@router.put("/{param_id}", response_model=TuningParameterView)
async def update_tuning_parameter(
    param_id: str,
    request: TuningUpdateRequest,
    service: TuningService = Depends(get_tuning_service),
) -> TuningParameterView:
    parameter = TUNING_PARAMETERS_BY_ID.get(param_id)
    if parameter is None:
        # 較正値の宣言に無いidは書かせない（較正値ではない固定値はこの逆引きに載らない）。
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=f"較正値がありません: {param_id}")
    await service.save_value(param_id, request.value)
    return tuning_parameter_view(parameter)
