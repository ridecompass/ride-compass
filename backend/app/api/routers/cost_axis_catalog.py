"""費用の軸の公開読み取りAPI。

画面（設定の軸ごとの倍率・結果の代償の内訳・地図のレンズと凡例）が、軸の名前・説明・アイコン・レンズの段と、軸の帳簿（体力か
道のストレスか）を読む。プロセス内の定義（`domain/model_settings.py: current_model_settings`）から返すので、管理APIで書いた定義は
再デプロイなしにここへ出る。
"""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Query
from fastapi.exceptions import RequestValidationError
from pydantic import TypeAdapter, ValidationError

from app.domain.axis_catalog import CostAxisCatalogResponse, current_cost_axis_catalog
from app.domain.cost_preference import STANDARD_COST_FACTOR, CostPreference, RequestedCostPreference

router = APIRouter()


@router.get("/api/cost-axes", response_model=CostAxisCatalogResponse)
async def get_cost_axis_catalog() -> CostAxisCatalogResponse:
    return await asyncio.to_thread(current_cost_axis_catalog)


_REQUESTED_COST_PREFERENCE: TypeAdapter[CostPreference] = TypeAdapter(RequestedCostPreference)
_MULTIPLIERS: TypeAdapter[dict[str, float]] = TypeAdapter(dict[str, float])
_AXIS_IDS: TypeAdapter[list[str]] = TypeAdapter(list[str])


def cost_preference_query(
    strength: float = STANDARD_COST_FACTOR,
    multipliers: Annotated[str | None, Query(description="軸id→倍率のJSONの object（書いていない軸は標準）")] = None,
    disabled_axes: Annotated[str | None, Query(description="数えない（無効にした）軸idのJSONの array")] = None,
) -> CostPreference:
    """地図のレンズ（タイル）の要求の利用者の値（ルート生成の`cost_preference`と同じ型・同じ検証。範囲と軸idは型が
    検め、誤りは型の検査と同じ形の422）。URL がそのまま応答のキャッシュの鍵になるので、クエリで受ける。"""
    try:
        parsed = {} if multipliers is None else _MULTIPLIERS.validate_json(multipliers)
        disabled = [] if disabled_axes is None else _AXIS_IDS.validate_json(disabled_axes)
        return _REQUESTED_COST_PREFERENCE.validate_python(
            {"strength": strength, "multipliers": parsed, "disabled_axes": disabled})
    except ValidationError as error:
        raise RequestValidationError(error.errors()) from error

