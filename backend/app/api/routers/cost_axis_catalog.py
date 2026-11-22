"""費用の軸の公開読み取りAPI。

画面（設定の軸ごとの倍率・結果の代償の内訳・地図のレンズと凡例）が、軸の名前・説明・アイコン・レンズの段と、軸の帳簿（体力か
道のストレスか）を読む。プロセス内の定義（`domain/model_settings.py: current_model_settings`）から返すので、管理APIで書いた定義は
再デプロイなしにここへ出る。
"""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.exceptions import RequestValidationError
from pydantic import Field, TypeAdapter, ValidationError

from app.domain.cost_axes import AxisPresentation, CostAxisCatalogEntry, cost_axis_catalog
from app.domain.cost_preference import STANDARD_COST_FACTOR, CostPreference, RequestedCostPreference
from app.domain.lens_total import TOTAL_LENS_ID
from app.domain.ledger_costs import ledger_parameters
from app.domain.lens_equivalents import LensEquivalents, lens_equivalents
from app.domain.lens_values import LENS_MATERIAL_CONDITIONS, lens_way_formula
from app.domain.model_settings import current_model_settings
from app.domain.strict_model import StrictModel
from app.domain.way_value_formula import WayValueConditionName, WayValueFormula

router = APIRouter()


class MapLens(StrictModel):
    """地図が道をレンズで塗る決まり。道ごとの材料は`/api/region/lens/{lens_id}/...`（`lens_id`は`total_lens.lens_id`か
    軸id）で、要求には`material_conditions`の走る条件を載せる。道の値は`formula`へ材料と走行方位を入れたもの。"""

    formula: WayValueFormula
    material_conditions: list[WayValueConditionName]


class TotalLens(AxisPresentation):
    """総合のレンズ（軸ごとの代償の秒の和）。軸ではないので倍率を持たない。"""

    lens_id: str


class CostAxisCatalogResponse(StrictModel):
    axes: list[CostAxisCatalogEntry]
    total_lens: TotalLens
    map_lens: MapLens


@router.get("/api/cost-axes", response_model=CostAxisCatalogResponse)
async def get_cost_axis_catalog() -> CostAxisCatalogResponse:
    settings = current_model_settings()
    definitions = settings.cost_axes
    return CostAxisCatalogResponse(
        axes=cost_axis_catalog(definitions),
        total_lens=TotalLens(lens_id=TOTAL_LENS_ID, **definitions.total_lens.model_dump()),
        map_lens=MapLens(formula=lens_way_formula(settings.tuning), material_conditions=list(LENS_MATERIAL_CONDITIONS)),
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


#: 軸id→段の境目の目安（`domain/lens_equivalents.py`）。
LensEquivalentsResponse = dict[str, Annotated[LensEquivalents, Field(discriminator="kind")]]


@router.get("/api/cost-axes/lens-equivalents", response_model=LensEquivalentsResponse)
async def get_lens_equivalents(
    preference: CostPreference = Depends(cost_preference_query),
) -> LensEquivalentsResponse:
    """地図のレンズの段の境目の秒が、利用者の値（つまみと倍率。地図のレンズと同じクエリ）で、その事実1つだけが効いた無風の
    1kmの道のどれだけの事実に当たるかの目安（体力の軸をコードの表の順、続けて道のストレスの軸）。地図が塗る色と凡例の目安を同じ
    値で揃える。"""
    settings = current_model_settings()
    # 目安は合成の道で走行の模型を解くので、イベントループの外で求める。
    return await asyncio.to_thread(lens_equivalents, settings, ledger_parameters(preference, settings.tuning))
