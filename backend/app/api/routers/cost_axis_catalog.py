"""費用の軸の公開読み取りAPI。

画面（設定の軸ごとの倍率・結果の代償の内訳・地図のレンズと凡例）が、軸の名前・説明・アイコン・レンズの段と、軸の帳簿（体力か
道のストレスか）を読む。プロセス内の定義（`domain/cost_axes.py: current_cost_axes`）から返すので、管理APIで書いた定義は
再デプロイなしにここへ出る。
"""

import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.exceptions import RequestValidationError
from pydantic import Field, TypeAdapter, ValidationError

from app.domain.cost_axes import (
    AVOIDANCE_LABEL,
    EFFORT_AXES,
    AxisPresentation,
    LensBands,
    current_cost_axes,
)
from app.domain.cost_preference import STANDARD_COST_FACTOR, CostPreference, RequestedCostPreference
from app.domain.lens_total import TOTAL_LENS_ID
from app.domain.ledger_costs import current_ledger_parameters
from app.domain.lens_equivalents import LensEquivalents, lens_equivalents
from app.domain.lens_values import LENS_MATERIAL_CONDITIONS, lens_way_formula
from app.domain.road_classes import current_road_classes
from app.domain.strict_model import StrictModel
from app.domain.way_value_formula import WayValueConditionName, WayValueFormula

router = APIRouter()


class CostAxisCatalogEntry(StrictModel):
    axis_id: str
    #: 軸の費目を書く帳簿。体力（`effort`）は走行の模型の物理の費目、道のストレス（`burden`）は材料 × 1kmあたりの重さ。
    ledger: Literal["effort", "burden"]
    label: str
    description: str
    icon_id: str
    #: 地図のレンズの段（境目は1kmあたりの代償の秒）。境目が利用者の値でどれだけの事実に当たるかの目安は
    #: `GET /api/cost-axes/lens-equivalents`。
    lens: LensBands


class MapLens(StrictModel):
    """地図が道をレンズで塗る決まり。道ごとの材料は`/api/region/lens/{lens_id}/...`（`lens_id`は`total_lens.lens_id`か
    軸id）で、要求には`material_conditions`の走る条件を載せる。道の値は`formula`へ材料と走行方位を入れたもの。"""

    formula: WayValueFormula
    material_conditions: list[WayValueConditionName]


class TotalLens(AxisPresentation):
    """総合のレンズ（軸ごとの代償の秒の和）。軸ではないので倍率を持たない。"""

    lens_id: str


class CostAxisCatalogResponse(StrictModel):
    #: 体力の軸をコードの表の順、続けて道のストレスの軸を定義の順で。
    axes: list[CostAxisCatalogEntry]
    #: 代償の内訳の、避け方の倍率で上乗せした秒の行の名前（軸ではないので、倍率を持たない）。
    avoidance_label: str
    total_lens: TotalLens
    map_lens: MapLens


@router.get("/api/cost-axes", response_model=CostAxisCatalogResponse)
async def get_cost_axis_catalog() -> CostAxisCatalogResponse:
    definitions = current_cost_axes()
    effort = [
        CostAxisCatalogEntry(axis_id=axis_id, ledger="effort",
                             **definitions.effort[axis_id].model_dump())
        for axis_id in EFFORT_AXES
    ]
    burden = [
        CostAxisCatalogEntry(axis_id=axis_id, ledger="burden",
                             **axis.model_dump(exclude={"burden"}))
        for axis_id, axis in definitions.burden.items()
    ]
    return CostAxisCatalogResponse(
        axes=[*effort, *burden], avoidance_label=AVOIDANCE_LABEL,
        total_lens=TotalLens(lens_id=TOTAL_LENS_ID, **definitions.total_lens.model_dump()),
        map_lens=MapLens(formula=lens_way_formula(), material_conditions=list(LENS_MATERIAL_CONDITIONS)),
    )


_REQUESTED_COST_PREFERENCE: TypeAdapter[CostPreference] = TypeAdapter(RequestedCostPreference)
_MULTIPLIERS: TypeAdapter[dict[str, float]] = TypeAdapter(dict[str, float])


def cost_preference_query(
    strength: float = STANDARD_COST_FACTOR,
    multipliers: Annotated[str | None, Query(description="軸id→倍率のJSONの object（書いていない軸は標準）")] = None,
) -> CostPreference:
    """地図のレンズ（タイル）と凡例の目安の要求の利用者の値（ルート生成の`cost_preference`と同じ型・同じ検証。範囲と軸idは型が
    検め、誤りは型の検査と同じ形の422）。URL がそのまま応答のキャッシュの鍵になるので、クエリで受ける。"""
    try:
        parsed = {} if multipliers is None else _MULTIPLIERS.validate_json(multipliers)
        return _REQUESTED_COST_PREFERENCE.validate_python({"strength": strength, "multipliers": parsed})
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
    definitions = current_cost_axes()
    # 目安は合成の道で走行の模型を解くので、イベントループの外で求める。
    return await asyncio.to_thread(
        lens_equivalents, definitions, current_ledger_parameters(preference), current_road_classes())
