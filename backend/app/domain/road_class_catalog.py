"""道の区分の全体を、画面の設定で配る形（解決した見せ方）へ組む。

配るのは公開した分け方だけで、管理用の欄（公開か・条件）は配らない
（条件は管理の経路でだけ見せ、区分の説明は意味の文だけにする）。色・層の説明のうち区分から組む部分は
ここで決め、受け取る側は組み直さない。並びは`sort_order`の順で、振り分けには使わない。
"""


from app.domain.display_palette import nominal_colors, ordered_colors, ordered_ends_phrase
from app.domain.cost_preference import multiplier_label
from app.domain.road_avoidance import AVOIDANCE_LEVELS, AvoidanceLevel, avoidance_rows, level_multipliers
from app.domain.road_classes import (
    RoadClassDefinitions,
    by_sort_order,
    published_map_layers,
    road_class_generation,
)
from app.domain.strict_model import StrictModel


class RoadClassView(StrictModel):
    key: str
    label: str
    description: str
    color: str
    #: 暗い地図の上に塗る色。
    color_on_dark: str


class RoadMapLayerView(StrictModel):
    """地図の道の線の層1つ。`id`は描く分け方。層に共通の宣言（情報源・既定の表示）は`domain/map_display.py: AXIS_LAYER_SPECS`の`road`。"""

    id: str
    label: str
    category: str
    icon: str
    description: list[str]
    panel_hint: str
    hide_missing_rows: bool
    #: 区分の外の道を「データなし」（`domain/road_classes.py: NO_DATA_VALUE`）と「該当なし」に分けるか。
    has_no_data: bool
    classes: list[RoadClassView]


class AvoidanceLevelView(StrictModel):
    key: AvoidanceLevel
    #: 掛ける倍率そのもの（`domain/cost_preference.py: multiplier_label`）。
    label: str


class AvoidanceSectionView(StrictModel):
    """道路タブの見出し1つ。鍵・名前は分け方の鍵・名前で、地図の線の層（`RoadMapLayerView`）と揃う。"""

    key: str
    label: str


class AvoidanceRowView(StrictModel):
    """道路タブの1行。`key`は`<分け方>.<区分>`、`section`は見出し（分け方）の鍵。"""

    key: str
    section: str
    label: str
    description: str
    default: AvoidanceLevel


class RoadAvoidanceView(StrictModel):
    #: 並びは倍率の小さい順。
    levels: list[AvoidanceLevelView]
    #: 並びは行の並び（地図の線の層の並び）。行の無い見出しは出さない。
    sections: list[AvoidanceSectionView]
    rows: list[AvoidanceRowView]


class RoadClassCatalog(StrictModel):
    #: 区分の中身から作る指紋（`domain/road_classes.py: road_class_generation`）。公開していない分け方の変化でも替わる。
    generation: str
    map_layers: list[RoadMapLayerView]
    avoidance: RoadAvoidanceView


def road_class_catalog(definitions: RoadClassDefinitions, avoid_cost_multiplier: float) -> RoadClassCatalog:
    """`avoid_cost_multiplier`は較正値`avoidance.avoid_cost_multiplier`（段の名前の数字になる）。"""
    layers = []
    for key, layer in published_map_layers(definitions):
        classification = definitions.classifications[key]
        classes = by_sort_order(classification.classes)
        labels = [road_class.label for _, road_class in classes]
        if layer.palette == "ordered":
            colors, colors_on_dark = ordered_colors(len(classes)), ordered_colors(len(classes), on_dark=True)
            part = ordered_ends_phrase(labels[0], labels[-1]) if labels else ""
        else:
            colors = nominal_colors(layer.hue_slot, len(classes), layer.tone)
            colors_on_dark = nominal_colors(layer.hue_slot, len(classes), layer.tone, on_dark=True)
            # 区分が1つだけなら、見分けるものが無く、名前は要約の言い直しになるので並べない。
            part = "・".join(labels) if len(labels) > 1 else ""
        layers.append(
            RoadMapLayerView(
                id=key,
                label=classification.label,
                category=layer.group_key,
                icon=layer.icon_key,
                description=[f"{layer.summary}[{part}]" if part else layer.summary],
                panel_hint=layer.panel_hint,
                hide_missing_rows=layer.hides_unclassified,
                has_no_data=layer.no_data_fact_key is not None,
                classes=[
                    RoadClassView(
                        key=class_key,
                        label=road_class.label,
                        description=road_class.description,
                        color=color,
                        color_on_dark=color_on_dark,
                    )
                    for (class_key, road_class), color, color_on_dark in zip(classes, colors, colors_on_dark, strict=True)
                ],
            )
        )
    avoidance = avoidance_rows(definitions)
    multipliers = level_multipliers(avoid_cost_multiplier)
    rows = [
        AvoidanceRowView(
            key=row.key,
            section=row.classification_key,
            label=row.road_class.label,
            description=row.road_class.description,
            default=row.default_level,
        )
        for row in avoidance
    ]
    return RoadClassCatalog(
        generation=road_class_generation(definitions),
        map_layers=layers,
        avoidance=RoadAvoidanceView(
            levels=[
                AvoidanceLevelView(key=level, label=multiplier_label(multipliers[level]))
                for level in sorted(AVOIDANCE_LEVELS, key=multipliers.__getitem__)
            ],
            sections=[
                AvoidanceSectionView(key=key, label=definitions.classifications[key].label)
                for key in dict.fromkeys(row.classification_key for row in avoidance)
            ],
            rows=rows,
        ),
    )
