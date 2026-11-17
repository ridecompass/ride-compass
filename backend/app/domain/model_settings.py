"""1回の計算が読む較正値・道の区分・費用の軸の定義の束。

管理APIはプロセス内の全体を計算の途中でも書き換えるので、計算（domain）は全体を読まず、この束を値で受ける。
全体から写すのは入口（services・batch・道具）だけで、1回の生成・応答の間は同じ写しを回す。
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
