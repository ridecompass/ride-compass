"""道の区分の全体を、公開の軸カタログで配る形（解決した見せ方）へ組む。

配るのは公開した分け方だけで、管理用の欄（公開か）は配らない。色・タグの注・層の説明のうち区分から組む部分は
ここで決め、受け取る側は組み直さない。並びは`sort_order`の順で、振り分けには使わない。
"""

from typing import Literal

from app.domain.display_palette import nominal_colors, ordered_colors, ordered_ends_phrase
from app.domain.material_catalog import material_spec
from app.domain.road_avoidance import AVOIDANCE_LEVEL_LABELS, AVOIDANCE_LEVELS, AvoidanceLevel, avoidance_rows
from app.domain.road_classes import Condition, RoadClass, RoadClassDefinitions, by_sort_order, road_class_generation
from app.domain.strict_model import StrictModel


class RoadClassView(StrictModel):
    key: str
    label: str
    #: 意味の文に、条件から組んだタグの注を足したもの。
    description: str
    color: str


class LayerTextSlotView(StrictModel):
    """説明の文の差し込み口（`domain/map_display.py: LayerTextSlot`）。"""

    name: Literal["axes"]
    before: str
    after: str


class RoadMapLayerView(StrictModel):
    """地図の道の線の層1つ。`id`は描く分け方。層に共通の宣言（情報源・既定の表示）は`domain/map_display.py: AXIS_LAYER_SPECS`の`road`。"""

    id: str
    label: str
    category: str
    icon: str
    description: list[str]
    panel_hint: list[str | LayerTextSlotView]
    hide_missing_rows: bool
    #: 区分の外の道を「データなし」（`domain/road_classes.py: NO_DATA_VALUE`）と「該当なし」に分けるか。
    has_no_data: bool
    classes: list[RoadClassView]


class AvoidanceLevelView(StrictModel):
    key: AvoidanceLevel
    label: str


class AvoidanceSectionView(StrictModel):
    key: str
    label: str
    description: str


class AvoidanceRowView(StrictModel):
    """除外タブの1行。`key`は`<分け方>.<区分>`。"""

    key: str
    section: str
    label: str
    description: str
    default: AvoidanceLevel
    former_keys: list[str]


class RoadAvoidanceView(StrictModel):
    levels: list[AvoidanceLevelView]
    sections: list[AvoidanceSectionView]
    rows: list[AvoidanceRowView]


class RoadClassCatalog(StrictModel):
    #: 区分の中身から作る指紋（`domain/road_classes.py: road_class_generation`）。公開していない分け方の変化でも替わる。
    generation: str
    map_layers: list[RoadMapLayerView]
    avoidance: RoadAvoidanceView


_AXES_SLOT = LayerTextSlotView(name="axes", before="評価軸", after="の材料の1つです。")


def _fact_label(fact_key: str) -> str:
    spec = material_spec(fact_key)
    return fact_key if spec is None else spec.label


def _term_note(fact_key: str, values: list[str], negated: bool, matches_absent: bool) -> str:
    label = _fact_label(fact_key)
    if values:
        text = f"{label}が{'・'.join(values)}{'以外' if negated else ''}"
        return text + ("か無い" if matches_absent else "")
    return f"{label}が{'ある' if negated else '無い'}"


def _conditions_note(conditions: list[Condition]) -> str:
    return "、または".join(
        " かつ ".join(_term_note(key, t.fact_values, t.negated, t.matches_absent) for key, t in condition.items())
        for condition in conditions
    )


def _described(road_class: RoadClass) -> str:
    note = _conditions_note(road_class.conditions)
    return f"{road_class.description}[{note}]" if note else road_class.description


def road_class_catalog(definitions: RoadClassDefinitions) -> RoadClassCatalog:
    published = {key: c for key, c in definitions.classifications.items() if c.is_published}
    layers = []
    for key, layer in sorted(definitions.map_layers.items(), key=lambda item: (item[1].group_key, item[1].sort_order)):
        classification = published.get(key)
        if classification is None:
            continue
        classes = by_sort_order(classification.classes)
        labels = [road_class.label for _, road_class in classes]
        if layer.palette == "ordered":
            colors = ordered_colors(len(classes))
            part = ordered_ends_phrase(labels[0], labels[-1]) if labels else ""
        else:
            colors = nominal_colors(layer.hue_slot or 0, len(classes), layer.tone)
            part = "・".join(labels)
        layers.append(
            RoadMapLayerView(
                id=key,
                label=classification.label,
                category=layer.group_key,
                icon=layer.icon_key,
                description=[f"{layer.summary}[{part}]" if part else layer.summary],
                panel_hint=[layer.panel_hint, _AXES_SLOT],
                hide_missing_rows=layer.hides_unclassified,
                has_no_data=layer.no_data_fact_key is not None,
                classes=[
                    RoadClassView(
                        key=class_key,
                        label=road_class.label,
                        description=_described(road_class),
                        color=color,
                    )
                    for (class_key, road_class), color in zip(classes, colors, strict=True)
                ],
            )
        )
    rows = [
        AvoidanceRowView(
            key=row.key,
            section=row.section_key,
            label=row.road_class.label,
            description=_described(row.road_class),
            default=row.default_level,
            former_keys=row.road_class.former_keys,
        )
        for row in avoidance_rows(definitions)
    ]
    return RoadClassCatalog(
        generation=road_class_generation(definitions),
        map_layers=layers,
        avoidance=RoadAvoidanceView(
            levels=[AvoidanceLevelView(key=level, label=AVOIDANCE_LEVEL_LABELS[level]) for level in AVOIDANCE_LEVELS],
            sections=[
                AvoidanceSectionView(key=key, label=section.label, description=section.description)
                for key, section in by_sort_order(definitions.avoidance_sections)
            ],
            rows=rows,
        ),
    )
