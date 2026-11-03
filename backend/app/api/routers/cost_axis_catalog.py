"""費用の軸の公開読み取りAPI。

画面（設定の軸ごとの倍率・結果の代償の内訳・レンズの凡例）が、軸の名前・説明・アイコン・レンズの段と、軸の帳簿（体力か
道の負担か）を読む。プロセス内の定義（`domain/cost_axes.py: current_cost_axes`）から返すので、管理APIで書いた定義は
再デプロイなしにここへ出る。定義がまだ表に無い間（新しい式へ切り替える前）は404。
"""

from typing import Literal

from fastapi import APIRouter, HTTPException, status

from app.domain.cost_axes import AVOIDANCE_LABEL, EFFORT_AXES, LensBands, current_cost_axes
from app.domain.strict_model import StrictModel

router = APIRouter()


class CostAxisCatalogEntry(StrictModel):
    axis_id: str
    #: 軸の費目を書く帳簿。体力（`effort`）は走行の模型の物理の費目、道の負担（`burden`）は材料 × 1kmあたりの重さ。
    ledger: Literal["effort", "burden"]
    label: str
    description: str
    icon_id: str
    lens: LensBands


class CostAxisCatalogResponse(StrictModel):
    #: 体力の軸をコードの表の順、続けて道の負担の軸を定義の順で。
    axes: list[CostAxisCatalogEntry]
    #: 代償の内訳の、避け方の倍率で上乗せした秒の行の名前（軸ではないので、倍率を持たない）。
    avoidance_label: str


@router.get("/api/cost-axes", response_model=CostAxisCatalogResponse)
async def get_cost_axis_catalog() -> CostAxisCatalogResponse:
    definitions = current_cost_axes()
    if definitions is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="費用の軸の定義はまだありません")
    effort = [
        CostAxisCatalogEntry(axis_id=axis_id, ledger="effort", **definitions.effort[axis_id].model_dump())
        for axis_id in EFFORT_AXES
    ]
    burden = [
        CostAxisCatalogEntry(axis_id=axis_id, ledger="burden", **axis.model_dump(exclude={"burden"}))
        for axis_id, axis in definitions.burden.items()
    ]
    return CostAxisCatalogResponse(axes=[*effort, *burden], avoidance_label=AVOIDANCE_LABEL)
