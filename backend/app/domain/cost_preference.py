"""利用者の費用の好み（`CostPreference`）: 代償の全体に掛けるつまみと、費用の軸ごとの倍率。

費用の式（`domain/ledger_costs.py`）の利用者の値。どちらも標準は1で、0はその代償を数えない（つまみ0は所要時間だけで選ぶ）。
つまみは較正値`evaluation.penalty_strength`（標準的な人の強さ）に掛ける比なので、較正値を変えても利用者の値は標準のまま。
"""

from typing import Annotated, NamedTuple

from pydantic import Field, model_validator

from app.domain.cost_axes import cost_axis_ids, current_cost_axes
from app.domain.strict_model import StrictModel

#: つまみと倍率の標準。
STANDARD_COST_FACTOR = 1.0


class CostLevel(NamedTuple):
    """利用者が選ぶつまみ・倍率の段（値と、画面が出す名前）。"""

    value: float
    label: str


#: 全体のつまみの段。
COST_STRENGTH_LEVELS = (
    CostLevel(0.0, "気にしない"), CostLevel(0.5, "少し"), CostLevel(STANDARD_COST_FACTOR, "標準"), CostLevel(1.5, "強め"),
    CostLevel(2.0, "とても"),
)
#: 軸ごとの倍率の段。
COST_MULTIPLIER_LEVELS = (
    CostLevel(0.0, "無視"), CostLevel(0.5, "×0.5"), CostLevel(STANDARD_COST_FACTOR, "標準"), CostLevel(2.0, "×2"),
)
#: つまみ・倍率の上限（要求は段の間の値も受け付け、上の段より大きな値は断る）。
MAX_COST_STRENGTH = max(level.value for level in COST_STRENGTH_LEVELS)
MAX_COST_MULTIPLIER = max(level.value for level in COST_MULTIPLIER_LEVELS)


class CostPreference(StrictModel):
    """つまみと軸ごとの倍率。倍率のキーは今の費用の軸のidだけで、書いていない軸は標準（`resolved`で埋める）。"""

    strength: float = Field(default=STANDARD_COST_FACTOR, ge=0.0, le=MAX_COST_STRENGTH)
    multipliers: dict[str, Annotated[float, Field(ge=0.0, le=MAX_COST_MULTIPLIER)]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _check_axis_ids(self) -> "CostPreference":
        known = set(cost_axis_ids(current_cost_axes()))
        unknown = sorted(set(self.multipliers) - known)
        if unknown:
            raise ValueError(f"unknown cost axis in multipliers: {unknown} (known: {sorted(known)})")
        return self

    def resolved(self) -> "CostPreference":
        """今の費用の軸を全部、軸の順に書いた形（条件のエコーに返す——そのまま送り直せば同じ条件になる）。"""
        return CostPreference(
            strength=self.strength,
            multipliers={axis_id: self.multipliers.get(axis_id, STANDARD_COST_FACTOR)
                         for axis_id in cost_axis_ids(current_cost_axes())},
        )
