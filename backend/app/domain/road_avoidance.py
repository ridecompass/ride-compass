"""道の区分ごとの避け方（好む・少し好む・通る・少し避ける・なるべく避ける・通らない）。

選べる行は、除外の設定（`domain/road_classes.py: RoadClassDefinitions.avoidance_classifications`）が指す公開した分け方の区分で、
選べないとした区分を除く。鍵は`<分け方>.<区分>`で、行は分け方ごとの見出しにまとまる。区間が行に当たるかは、その分け方の区分の列から決める。
"""

import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, NamedTuple, cast, get_args

import numpy as np

from app.domain.attributes import CategoricalColumn
from app.domain.road_classes import (
    AvoidanceOverride,
    RoadClass,
    RoadClassDefinitions,
    by_sort_order,
    class_material_id,
    published_map_layers,
)

#: 避け方の段。1つの区間が複数の行に当たれば、倍率の大きい段を取る。「通る」は何も指定していない扱いで、ほかの行の段を
#: 打ち消さない。
AvoidanceLevel = Literal["pass", "slight_prefer", "prefer", "slight_avoid", "avoid", "exclude"]
AVOIDANCE_LEVELS: tuple[AvoidanceLevel, ...] = get_args(AvoidanceLevel)


def level_multipliers(avoid_cost_multiplier: float) -> dict[AvoidanceLevel, float]:
    """段→その段の区間の費用に掛ける倍率。「好む」は「なるべく避ける」の倍率（較正値`avoidance.avoid_cost_multiplier`）の
    逆数で、逆向きに同じ強さで効く。「少し」の段はその平方根（倍率の対数で「通る」との真ん中）。「通らない」は探索から除くので
    無限大。"""
    slight = math.sqrt(avoid_cost_multiplier)
    return {
        "pass": 1.0,
        "slight_prefer": 1.0 / slight,
        "prefer": 1.0 / avoid_cost_multiplier,
        "slight_avoid": slight,
        "avoid": avoid_cost_multiplier,
        "exclude": math.inf,
    }


class AvoidanceRow(NamedTuple):
    """避け方を選べる行1つ。"""

    #: 見出しにする分け方。
    classification_key: str
    class_key: str
    road_class: RoadClass
    override: AvoidanceOverride | None

    @property
    def key(self) -> str:
        """`<分け方>.<区分>`。"""
        return f"{self.classification_key}.{self.class_key}"

    @property
    def default_level(self) -> AvoidanceLevel:
        return cast(AvoidanceLevel, (self.override and self.override.default_level) or "pass")


def avoidance_rows(definitions: RoadClassDefinitions) -> list[AvoidanceRow]:
    """避け方を選べる行。並びは分け方の地図の線の層の並び（`domain/road_classes.py: published_map_layers`）、その中は区分の順。"""
    rows = []
    for key, _ in published_map_layers(definitions):
        avoidance = definitions.avoidance_classifications.get(key)
        if avoidance is None:
            continue
        for class_key, road_class in by_sort_order(definitions.classifications[key].classes):
            override = avoidance.overrides.get(class_key)
            if override is None or override.selectable:
                rows.append(AvoidanceRow(key, class_key, road_class, override))
    return rows


def resolve_road_avoidance(
    requested: Mapping[str, AvoidanceLevel], definitions: RoadClassDefinitions
) -> dict[str, AvoidanceLevel]:
    """要求の段を、今の行の鍵へ揃える。要求に無い行は既定の段を取り、今の行でない鍵は読まない（区分を直す前に読み込んだ画面の
    要求も断らない）。"""
    return {row.key: requested.get(row.key, row.default_level) for row in avoidance_rows(definitions)}


@dataclass(frozen=True)
class RoadAvoidanceMasks:
    """区間ごとの、避け方の段の結果（切り出した区間の順）。"""

    #: 「通らない」の行に当たる区間。
    excluded: np.ndarray
    #: 区間の費用に掛ける倍率（当たる行の段の倍率のうち一番大きいもの。どの行にも当たらない区間と、通らない区間は1）。
    cost_scale: np.ndarray


def road_avoidance_masks(
    classes: Mapping[str, CategoricalColumn],
    levels: Mapping[str, AvoidanceLevel],
    multipliers: Mapping[AvoidanceLevel, float],
    n: int,
) -> RoadAvoidanceMasks:
    """区分の列（`domain/road_classes.py: class_material_id`の鍵）と、行→段と、段→倍率（`level_multipliers`）から、区間ごとに
    当たる行の倍率のうち一番大きいものを求める。列の無い分け方の行と、列の語彙に無い区分の行は、どの区間にも当たらない。"""
    largest = np.full(n, np.nan)
    for key, level in levels.items():
        if level == "pass":
            continue
        classification_key, _, class_key = key.partition(".")
        column = classes.get(class_material_id(classification_key))
        if column is None or class_key not in column.vocab:
            continue
        hit = column.codes == column.vocab.index(class_key)
        largest[hit] = np.fmax(largest[hit], multipliers[level])
    excluded = np.isinf(largest)
    return RoadAvoidanceMasks(excluded=excluded, cost_scale=np.where(np.isnan(largest) | excluded, 1.0, largest))
