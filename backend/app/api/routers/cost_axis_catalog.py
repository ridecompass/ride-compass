"""費用の軸の公開読み取りAPI。

画面（設定の軸ごとの倍率・結果の代償の内訳・地図のレンズと凡例）が、軸の名前・説明・アイコン・レンズの段と、軸の帳簿（体力か
道の負担か）を読む。プロセス内の定義（`domain/cost_axes.py: current_cost_axes`）から返すので、管理APIで書いた定義は
再デプロイなしにここへ出る。定義がまだ表に無い間（新しい式へ切り替える前）は404。
"""

import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import Field

from app.domain.cost_axes import (
    AVOIDANCE_LABEL,
    EFFORT_AXES,
    TOTAL_LENS_ID,
    AxisPresentation,
    LensBands,
    current_cost_axes,
)
from app.domain.dynamic_way_values import WayValueConditionName
from app.domain.cost_preference import CostPreference
from app.domain.ledger_costs import current_ledger_parameters
from app.domain.lens_equivalents import LensEquivalents, lens_equivalents
from app.domain.lens_values import LENS_MATERIAL_CONDITIONS, lens_way_formula
from app.domain.road_classes import current_road_classes
from app.domain.strict_model import StrictModel
from app.domain.way_value_formula import WayValueFormula

router = APIRouter()


class CostAxisCatalogEntry(StrictModel):
    axis_id: str
    #: 軸の費目を書く帳簿。体力（`effort`）は走行の模型の物理の費目、道の負担（`burden`）は材料 × 1kmあたりの重さ。
    ledger: Literal["effort", "burden"]
    label: str
    description: str
    icon_id: str
    #: 地図のレンズの段（境目は1kmあたりの代償の秒）。
    lens: LensBands
    #: 段の境目の秒が、標準の条件でどれだけの事実に当たるかの目安（`domain/lens_equivalents.py`）。
    lens_equivalents: Annotated[LensEquivalents, Field(discriminator="kind")]


class MapLens(StrictModel):
    """地図が道をレンズで塗る決まり。道ごとの材料は`/api/region/lens/{lens_id}/...`（`lens_id`は`total_lens.lens_id`か
    軸id）で、要求には`material_conditions`の走る条件を載せる。道の値は`formula`へ材料と走行方位を入れたもの。"""

    formula: WayValueFormula
    material_conditions: list[WayValueConditionName]


class TotalLens(AxisPresentation):
    """総合のレンズ（軸ごとの代償の秒の和）。軸ではないので倍率を持たない。"""

    lens_id: str


class CostAxisCatalogResponse(StrictModel):
    #: 体力の軸をコードの表の順、続けて道の負担の軸を定義の順で。
    axes: list[CostAxisCatalogEntry]
    #: 代償の内訳の、避け方の倍率で上乗せした秒の行の名前（軸ではないので、倍率を持たない）。
    avoidance_label: str
    total_lens: TotalLens
    map_lens: MapLens


@router.get("/api/cost-axes", response_model=CostAxisCatalogResponse)
async def get_cost_axis_catalog() -> CostAxisCatalogResponse:
    definitions = current_cost_axes()
    if definitions is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="費用の軸の定義はまだありません")
    # 目安は合成の道で走行の模型を解くので、イベントループの外で求める。
    equivalents = await asyncio.to_thread(
        lens_equivalents, definitions, current_ledger_parameters(CostPreference()), current_road_classes())
    effort = [
        CostAxisCatalogEntry(axis_id=axis_id, ledger="effort", lens_equivalents=equivalents[axis_id],
                             **definitions.effort[axis_id].model_dump())
        for axis_id in EFFORT_AXES
    ]
    burden = [
        CostAxisCatalogEntry(axis_id=axis_id, ledger="burden", lens_equivalents=equivalents[axis_id],
                             **axis.model_dump(exclude={"burden"}))
        for axis_id, axis in definitions.burden.items()
    ]
    return CostAxisCatalogResponse(
        axes=[*effort, *burden], avoidance_label=AVOIDANCE_LABEL,
        total_lens=TotalLens(lens_id=TOTAL_LENS_ID, **definitions.total_lens.model_dump()),
        map_lens=MapLens(formula=lens_way_formula(), material_conditions=list(LENS_MATERIAL_CONDITIONS)),
    )
