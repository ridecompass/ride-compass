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

from app.domain.cost_axes import CostAxisCatalogEntry, LensBands, cost_axis_catalog
from app.domain.cost_preference import STANDARD_COST_FACTOR, CostPreference, RequestedCostPreference
from app.domain.lens_total import TOTAL_LENS_ID
from app.domain.lens_equivalents import lens_bands
from app.domain.lens_values import MapLens, lens_conditions, map_lens
from app.domain.model_settings import current_model_settings
from app.domain.strict_model import StrictModel

router = APIRouter()


class CostAxisCatalogItem(CostAxisCatalogEntry):
    """費用の軸1本の見せ方と、地図がその軸のレンズ（`lens_id`は軸id）で道を塗る決まり。"""

    map_lens: MapLens


class TotalLens(StrictModel):
    """総合のレンズ（軸ごとの代償の秒の和）。軸ではないので倍率を持たない。"""

    lens_id: str
    label: str
    description: str
    icon_id: str
    lens: LensBands
    map_lens: MapLens


class CostAxisCatalogResponse(StrictModel):
    axes: list[CostAxisCatalogItem]
    total_lens: TotalLens


@router.get("/api/cost-axes", response_model=CostAxisCatalogResponse)
async def get_cost_axis_catalog() -> CostAxisCatalogResponse:
    settings = current_model_settings()
    definitions = settings.cost_axes
    conditions = lens_conditions(definitions)
    # 段は合成の道で走行の模型を解くので、イベントループの外で求める。
    bands = await asyncio.to_thread(lens_bands, settings)
    total = definitions.total_lens
    return CostAxisCatalogResponse(
        axes=[CostAxisCatalogItem(**entry.model_dump(), map_lens=map_lens(conditions[entry.axis_id], settings.tuning))
              for entry in cost_axis_catalog(definitions, bands)],
        total_lens=TotalLens(lens_id=TOTAL_LENS_ID, label=total.label, description=total.description,
                             icon_id=total.icon_id, lens=bands[TOTAL_LENS_ID],
                             map_lens=map_lens(conditions[TOTAL_LENS_ID], settings.tuning)),
    )


_REQUESTED_COST_PREFERENCE: TypeAdapter[CostPreference] = TypeAdapter(RequestedCostPreference)
_MULTIPLIERS: TypeAdapter[dict[str, float]] = TypeAdapter(dict[str, float])
_AXIS_IDS: TypeAdapter[list[str]] = TypeAdapter(list[str])


def cost_preference_query(
    strength: float = STANDARD_COST_FACTOR,
    multipliers: Annotated[str | None, Query(description="軸id→倍率のJSONの object（書いていない軸は標準）")] = None,
    disabled_axes: Annotated[str | None, Query(description="数えない（無効にした）軸idのJSONの array")] = None,
) -> CostPreference:
    """地図のレンズ（タイル）と凡例の目安の要求の利用者の値（ルート生成の`cost_preference`と同じ型・同じ検証。範囲と軸idは型が
    検め、誤りは型の検査と同じ形の422）。URL がそのまま応答のキャッシュの鍵になるので、クエリで受ける。"""
    try:
        parsed = {} if multipliers is None else _MULTIPLIERS.validate_json(multipliers)
        disabled = [] if disabled_axes is None else _AXIS_IDS.validate_json(disabled_axes)
        return _REQUESTED_COST_PREFERENCE.validate_python(
            {"strength": strength, "multipliers": parsed, "disabled_axes": disabled})
    except ValidationError as error:
        raise RequestValidationError(error.errors()) from error

