"""テストが道の区分を組み立て、プロセス内の全体（`domain/road_classes.py: replace_road_classes`）へ入れるための道具。

区分の正本は管理DBで、テストの中では空（`EMPTY_ROAD_CLASSES`）から始まる。区分を要るテストは、見たい性質だけを持つ
分け方をそのファイルで組み、ここの道具で入れる。
"""

from collections.abc import Mapping
from contextlib import contextmanager
from typing import Any

from app.domain.road_classes import (
    EMPTY_ROAD_CLASSES,
    Condition,
    ConditionTerm,
    RoadClass,
    RoadClassDefinitions,
    RoadClassification,
    RoadMapLayer,
    current_road_classes,
    replace_road_classes,
)


def fact_is(fact_key: str, *values: str) -> Condition:
    """事実`fact_key`の値が`values`のどれかの道に当たる条件。"""
    return {fact_key: ConditionTerm(fact_values=list(values), negated=False, matches_absent=False)}


def classification(classes: Mapping[str, list[Condition]], *, former_keys: Mapping[str, list[str]] | None = None) -> RoadClassification:
    """区分の鍵→条件から、公開した分け方を作る。並びは`classes`の順。"""
    return RoadClassification(
        label="分け方",
        description="",
        is_published=True,
        classes={
            key: RoadClass(
                label=f"区分{key}", description="", sort_order=position,
                former_keys=list((former_keys or {}).get(key, [])), conditions=conditions,
            )
            for position, (key, conditions) in enumerate(classes.items())
        },
    )


def map_layer(sort_order: int = 0) -> RoadMapLayer:
    """地図の線の層1つ。並び以外の欄は空。"""
    return RoadMapLayer(
        group_key="", sort_order=sort_order, icon_key="", summary="", panel_hint="", palette="ordered",
        hue_slot=None, tone=None, no_data_fact_key=None, hides_unclassified=False,
    )


def road_classes(classifications: Mapping[str, RoadClassification], **fields: Any) -> RoadClassDefinitions:
    """分け方と、ほかの欄（`fields`。既定は空）から全体を作る。"""
    return EMPTY_ROAD_CLASSES.model_copy(update={"classifications": dict(classifications), **fields})


@contextmanager
def replaced_road_classes(definitions: RoadClassDefinitions):
    """ブロックの間だけ、プロセス内の全体を`definitions`にする。"""
    original = current_road_classes()
    replace_road_classes(definitions)
    try:
        yield
    finally:
        replace_road_classes(original)
