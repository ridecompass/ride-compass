"""利用者の費用の好み（`CostPreference`）: 代償の全体に掛けるつまみと、費用の軸ごとの倍率と、数えない（無効にした）軸。

費用の式（`domain/ledger_costs.py`）の利用者の値。つまみと倍率の標準は1で、つまみ0は所要時間だけで選ぶ。軸を数えないことは
倍率の値（0）でなく無効という別の状態で表し、無効の軸は費用にも応答（内訳・事実・地図のレンズ）にも出ない。
つまみは較正値`evaluation.penalty_strength`（標準的な人の強さ）に掛ける比なので、較正値を変えても利用者の値は標準のまま。
"""

from typing import Annotated, NamedTuple

from pydantic import AfterValidator, Field

from app.domain.cost_axes import cost_axis_ids, current_cost_axes
from app.domain.strict_model import StrictModel

#: つまみと倍率の標準。
STANDARD_COST_FACTOR = 1.0


class CostLevel(NamedTuple):
    """利用者が選ぶつまみ・倍率の段（値と、画面が出す名前）。名前は掛ける数そのもの（「強め」のような言葉は量が伝わらない）。"""

    value: float
    label: str


def _levels(*values: float) -> tuple[CostLevel, ...]:
    return tuple(CostLevel(value, f"×{value:g}") for value in values)


#: 全体のつまみの段。
COST_STRENGTH_LEVELS = _levels(0.0, 0.5, STANDARD_COST_FACTOR, 1.5, 2.0)
#: 軸ごとの倍率の段（数えない軸は倍率でなく無効で表すので、0の段は無い）。
COST_MULTIPLIER_LEVELS = _levels(0.5, STANDARD_COST_FACTOR, 2.0)
#: つまみ・倍率の上限と倍率の下限（要求は段の間の値も受け付け、段の外の値は断る）。
MAX_COST_STRENGTH = max(level.value for level in COST_STRENGTH_LEVELS)
MAX_COST_MULTIPLIER = max(level.value for level in COST_MULTIPLIER_LEVELS)
MIN_COST_MULTIPLIER = min(level.value for level in COST_MULTIPLIER_LEVELS)


class CostPreference(StrictModel):
    """つまみと軸ごとの倍率と無効の軸。倍率を書いていない数える軸は標準（`resolved`で埋める）。キーが今の費用の軸のidかと、
    同じ軸を無効と倍率の両方に書いていないかは、要求を受ける側が`check_cost_axis_ids`で見る（応答に返した形を組み直すときに、
    その後に変わった軸の定義で検め直さない）。"""

    strength: float = Field(default=STANDARD_COST_FACTOR, ge=0.0, le=MAX_COST_STRENGTH)
    multipliers: dict[str, Annotated[float, Field(ge=MIN_COST_MULTIPLIER, le=MAX_COST_MULTIPLIER)]] = Field(
        default_factory=dict)
    # 数えない（無効にした）軸のid。
    disabled_axes: list[str] = Field(default_factory=list)

    def check_cost_axis_ids(self) -> "CostPreference":
        """倍率と無効のキーが今の費用の軸のidだけで、同じ軸を両方に書いていないか。知らない軸は効かず、両方に書いた軸は
        どちらが効くか決まらないので、黙って捨てずに断る。"""
        known = set(cost_axis_ids(current_cost_axes()))
        unknown = sorted((set(self.multipliers) | set(self.disabled_axes)) - known)
        if unknown:
            raise ValueError(f"unknown cost axis: {unknown} (known: {sorted(known)})")
        both = sorted(set(self.multipliers) & set(self.disabled_axes))
        if both:
            raise ValueError(f"cost axis both disabled and multiplied: {both}")
        return self

    def resolved(self) -> "CostPreference":
        """今の費用の軸を全部、軸の順に書いた形（数える軸は倍率に、無効の軸は無効に。条件のエコーに返す——そのまま送り直せば
        同じ条件になる）。"""
        disabled = set(self.disabled_axes)
        axis_ids = cost_axis_ids(current_cost_axes())
        return CostPreference(
            strength=self.strength,
            multipliers={axis_id: self.multipliers.get(axis_id, STANDARD_COST_FACTOR)
                         for axis_id in axis_ids if axis_id not in disabled},
            disabled_axes=[axis_id for axis_id in axis_ids if axis_id in disabled],
        )


#: 要求が受ける利用者の値（倍率のキーが今の費用の軸のidかを、受け取るときに検める）。ルート生成・地図のレンズ・道の窓の
#: どの入口もこの型で受ける。
RequestedCostPreference = Annotated[CostPreference, AfterValidator(CostPreference.check_cost_axis_ids)]
