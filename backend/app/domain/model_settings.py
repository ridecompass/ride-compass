"""1回の計算が読む較正値・道の区分・費用の軸の定義の束。

管理APIはプロセス内の全体を計算の途中でも書き換えるので、計算（domain）は全体を読まず、この束を値で受ける。
全体から写す口は`current_model_settings`だけで、呼ぶのは1回の要求・生成の入口（要求のモデル・services・batch・道具）が
1回だけ。その間は同じ写しを回す（区分・軸・較正値を別々に読むと、間に管理APIが書いたとき別の世代が混ざる）。
"""

from dataclasses import dataclass

from app.domain.cost_axes import CostAxisDefinitions, current_cost_axes
from app.domain.road_classes import RoadClassDefinitions, current_road_classes
from app.domain.tuning import Tuning, current_tuning


@dataclass(frozen=True)
class ModelSettings:
    tuning: Tuning
    road_classes: RoadClassDefinitions
    cost_axes: CostAxisDefinitions


def current_model_settings() -> ModelSettings:
    """いま効いている全体の写し。どれかを読み込む前なら止める。"""
    return ModelSettings(current_tuning(), current_road_classes(), current_cost_axes())
