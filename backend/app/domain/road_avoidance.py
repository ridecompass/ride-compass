"""道の区分ごとの避け方（通る・なるべく避ける・通らない）。

選べる行は、除外の設定（`domain/road_classes.py: RoadClassDefinitions.avoidance_classifications`）が指す公開した分け方の区分で、
選べないとした区分を除く。鍵は`<分け方>.<区分>`。区間が行に当たるかは、その分け方の区分の列から決める。
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, NamedTuple, cast, get_args

import numpy as np

from app.domain.attributes import CategoricalColumn
from app.domain.road_classes import AvoidanceOverride, RoadClass, RoadClassDefinitions, by_sort_order, class_material_id

#: 避け方の段。並びは弱い順で、1つの区間が複数の行に当たれば後ろ（強い）の段を取る。
AvoidanceLevel = Literal["pass", "avoid", "exclude"]
AVOIDANCE_LEVELS: tuple[AvoidanceLevel, ...] = get_args(AvoidanceLevel)
AVOIDANCE_LEVEL_LABELS: dict[AvoidanceLevel, str] = {"pass": "通る", "avoid": "なるべく避ける", "exclude": "通らない"}


class AvoidanceRow(NamedTuple):
    """避け方を選べる行1つ。"""

    #: `<分け方>.<区分>`。
    key: str
    section_key: str
    road_class: RoadClass
    override: AvoidanceOverride | None

    @property
    def default_level(self) -> AvoidanceLevel:
        return cast(AvoidanceLevel, (self.override and self.override.default_level) or "pass")


def avoidance_rows(definitions: RoadClassDefinitions) -> list[AvoidanceRow]:
    """避け方を選べる行。並びは除外の設定の分け方の順、その中は区分の順。"""
    rows = []
    for key, avoidance in by_sort_order(definitions.avoidance_classifications):
        classification = definitions.classifications[key]
        if not classification.is_published:
            continue
        for class_key, road_class in by_sort_order(classification.classes):
            override = avoidance.overrides.get(class_key)
            if override is None or override.selectable:
                section = (override and override.section_key) or avoidance.section_key
                rows.append(AvoidanceRow(f"{key}.{class_key}", section, road_class, override))
    return rows


def resolve_road_avoidance(
    requested: Mapping[str, AvoidanceLevel], definitions: RoadClassDefinitions
) -> dict[str, AvoidanceLevel]:
    """要求の段を、今の行の鍵へ揃える。今の鍵が無い行は前の鍵の段のうち強い方を、どちらも無い行は既定の段を取る。
    今の行でも前の鍵でもない鍵は読まない（区分を直す前に読み込んだ画面の要求も断らない）。"""
    resolved: dict[str, AvoidanceLevel] = {}
    for row in avoidance_rows(definitions):
        # 前の鍵は区分のデータが持ち、入れてから3か月で外す（`domain/road_classes.py: RoadClass.former_keys`）。
        keys = [row.key] if row.key in requested else [key for key in row.road_class.former_keys if key in requested]
        resolved[row.key] = max((requested[key] for key in keys), key=AVOIDANCE_LEVELS.index, default=row.default_level)
    return resolved


@dataclass(frozen=True)
class RoadAvoidanceMasks:
    """区間ごとの、避け方の段の結果（切り出した区間の順）。"""

    #: 「通らない」の行に当たる区間。
    excluded: np.ndarray
    #: 「なるべく避ける」の行に当たる区間。除く区間にも当たりうるが、除く方が先に効く。
    avoided: np.ndarray


def road_avoidance_masks(
    classes: Mapping[str, CategoricalColumn], levels: Mapping[str, AvoidanceLevel], n: int
) -> RoadAvoidanceMasks:
    """区分の列（`domain/road_classes.py: class_material_id`の鍵）と、行→段から、区間ごとの段を求める。
    列の無い分け方の行と、列の語彙に無い区分の行は、どの区間にも当たらない。"""
    excluded = np.zeros(n, dtype=bool)
    avoided = np.zeros(n, dtype=bool)
    for key, level in levels.items():
        if level == "pass":
            continue
        classification_key, _, class_key = key.partition(".")
        column = classes.get(class_material_id(classification_key))
        if column is None or class_key not in column.vocab:
            continue
        hit = column.codes == column.vocab.index(class_key)
        if level == "exclude":
            excluded |= hit
        else:
            avoided |= hit
    return RoadAvoidanceMasks(excluded=excluded, avoided=avoided)
