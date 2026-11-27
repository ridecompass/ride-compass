"""利用者の費用の好み（`CostPreference`）: 代償の全体に掛けるつまみと、費用の軸ごとの倍率と、数えない（無効にした）軸。

費用の式（`domain/ledger_costs.py`）の利用者の値。つまみと倍率の標準は1で、つまみ0は所要時間だけで選ぶ。軸を数えないことは
倍率の値（0）でなく無効という別の状態で表し、無効の軸は費用にも応答（内訳・事実・地図のレンズ）にも出ない。
標準の人の強さは較正値の交換比（α・β）が持つので、較正値を変えても利用者の値は標準のまま。
"""

import math
from typing import Annotated, NamedTuple

from pydantic import Field

from app.domain.cost_axes import CostAxisDefinitions, cost_axis_ids
from app.domain.display_palette import SEMANTIC_COLORS
from app.domain.strict_model import StrictModel

#: つまみと倍率の標準。
STANDARD_COST_FACTOR = 1.0


class CostLevel(NamedTuple):
    """利用者が選ぶつまみ・倍率の段（値と、画面が出す名前）。名前は負担を数える割合（「強め」のような言葉は量が伝わらない）。
    道の区分の倍率（`multiplier_label`の「×0.5」）は道の重さそのものに掛ける数で働きが違うので、同じ書き方にしない。"""

    value: float
    label: str
    #: 段の色。標準と無効の段は塗らない（None）。
    color: str | None


def multiplier_label(value: float) -> str:
    """掛ける数の段の画面に出す名前（掛ける数を小数1桁に丸め、末尾の0は書かない。無限大は「×∞」）。"""
    return "×∞" if math.isinf(value) else f"×{round(value, 1):g}"


#: 負担を数えないことの、段と並べて出す名前（費用の軸の無効と、全体のつまみの0）。
DISABLED_LABEL = "無効"


#: 標準より大きい段の色の役割。負担を重く見て避けやすくするので、道路タブの「なるべく避ける」と同じ。
_HIGHER_COLOR_ROLE = "road_avoidance_avoid"


def _level(value: float, lower_color_role: str) -> CostLevel:
    role = (None if value in (0, STANDARD_COST_FACTOR)
            else lower_color_role if value < STANDARD_COST_FACTOR else _HIGHER_COLOR_ROLE)
    return CostLevel(value, DISABLED_LABEL if value == 0 else f"{round(value * 100)}%",
                     None if role is None else SEMANTIC_COLORS[role])


def _levels(lower_color_role: str, *values: float) -> tuple[CostLevel, ...]:
    """段`values`。標準より小さい段の色の役割（`domain/display_palette.py: SEMANTIC_COLORS`の鍵）は`lower_color_role`。"""
    return tuple(_level(value, lower_color_role) for value in values)


#: 全体のつまみの段。0は「無効」で、どの軸も数えない（全部の軸を無効にしたのと同じ。`CostPreference.counts`）。
#: 小さい段は負担をまとめて軽く見るだけで、どの道を好むのでもないので、好む色にしない。
COST_STRENGTH_LEVELS = _levels("neutral", 0.0, 0.5, STANDARD_COST_FACTOR, 1.5, 2.0)
#: 軸ごとの倍率の段（数えない軸は倍率でなく無効で表すので、0の段は無い）。小さい段はその負担を軽く見て通りやすく
#: するので、道路タブの「好む」と同じ色の役割。
COST_MULTIPLIER_LEVELS = _levels("road_avoidance_prefer", 0.5, STANDARD_COST_FACTOR, 2.0)
#: つまみ・倍率の上限と倍率の下限（要求は段の間の値も受け付け、段の外の値は断る）。
MAX_COST_STRENGTH = max(level.value for level in COST_STRENGTH_LEVELS)
MAX_COST_MULTIPLIER = max(level.value for level in COST_MULTIPLIER_LEVELS)
MIN_COST_MULTIPLIER = min(level.value for level in COST_MULTIPLIER_LEVELS)


class CostPreference(StrictModel):
    """つまみと軸ごとの倍率と無効の軸。倍率を書いていない数える軸は標準（`resolved`で埋める）。キーがその要求の費用の軸のidかと、
    同じ軸を無効と倍率の両方に書いていないかは、要求を受ける側が計算に渡すのと同じ定義で`check_cost_axis_ids`に見させる（応答に
    返した形を組み直すときに、その後に変わった軸の定義で検め直さない）。"""

    strength: float = Field(default=STANDARD_COST_FACTOR, ge=0.0, le=MAX_COST_STRENGTH)
    multipliers: dict[str, Annotated[float, Field(ge=MIN_COST_MULTIPLIER, le=MAX_COST_MULTIPLIER)]] = Field(
        default_factory=dict)
    # 数えない（無効にした）軸のid。
    disabled_axes: list[str] = Field(default_factory=list)

    def counts(self, axis_id: str) -> bool:
        """軸`axis_id`を数えるか（つまみを無効（0）にしておらず、その軸を無効にしていないか）。利用者の値だけで決め、較正値には
        依らない（利用者の値を持つ側は、較正値を受け取らずに同じ答えを出せる）。"""
        return self.strength > 0 and axis_id not in self.disabled_axes

    def check_cost_axis_ids(self, axes: CostAxisDefinitions) -> "CostPreference":
        """倍率と無効のキーが費用の軸`axes`のidだけで、同じ軸を両方に書いていないか。知らない軸は効かず、両方に書いた軸は
        どちらが効くか決まらないので、黙って捨てずに断る。"""
        known = set(cost_axis_ids(axes))
        unknown = sorted((set(self.multipliers) | set(self.disabled_axes)) - known)
        if unknown:
            raise ValueError(f"unknown cost axis: {unknown} (known: {sorted(known)})")
        both = sorted(set(self.multipliers) & set(self.disabled_axes))
        if both:
            raise ValueError(f"cost axis both disabled and multiplied: {both}")
        return self

    def resolved(self, axes: CostAxisDefinitions) -> "CostPreference":
        """費用の軸`axes`を全部、軸の順に書いた形（数える軸は倍率に、無効の軸は無効に。条件のエコーに返す——そのまま送り直せば
        同じ条件になる）。"""
        disabled = set(self.disabled_axes)
        axis_ids = cost_axis_ids(axes)
        return CostPreference(
            strength=self.strength,
            multipliers={axis_id: self.multipliers.get(axis_id, STANDARD_COST_FACTOR)
                         for axis_id in axis_ids if axis_id not in disabled},
            disabled_axes=[axis_id for axis_id in axis_ids if axis_id in disabled],
        )
