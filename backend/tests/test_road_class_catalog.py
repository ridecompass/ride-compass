"""道の区分を軸カタログで配る形（`domain/road_class_catalog.py: road_class_catalog`）を見る。

材料カタログは本番の正本を読まず、性質だけを持つ架空の材料へ差し替える（`MATERIAL_CATALOG`）。

ここで見ないもの:
- 区分に道を振り分ける式 → `test_road_classes.py`
- 色そのものの作り方（`domain/display_palette.py`） → `test_display_palette.py`
- 表との往復と、応答のどこへ出るか → `test_road_class_admin_routes.py`
"""

import pytest

from app.domain import road_class_catalog as catalog_module
from app.domain.display_palette import nominal_colors, ordered_colors, ordered_ends_phrase
from app.domain.material_catalog import CoverageExcluded, MaterialSpec
from app.domain.road_class_catalog import road_class_catalog
from app.domain.road_classes import (
    AvoidanceClassification,
    AvoidanceOverride,
    AvoidanceSection,
    ConditionTerm,
    RoadClass,
    RoadClassDefinitions,
    RoadClassification,
    RoadMapLayer,
)


def _material(material_id: str, label: str, tile_property: str | None) -> MaterialSpec:
    return MaterialSpec(
        material_id=material_id,
        label=label,
        description="架空の材料",
        dtype="categorical",
        unit="",
        tile_property=tile_property,
        value_sql=f"w.{material_id}",
        coverage=CoverageExcluded(reason="架空", missing_semantics="definite"),
    )


CATALOG = {spec.material_id: spec for spec in [_material("cat_a", "種別", "kind"), _material("cat_hidden", "隠れ", None)]}


@pytest.fixture
def catalog(monkeypatch) -> None:
    monkeypatch.setattr(catalog_module, "MATERIAL_CATALOG", CATALOG)


pytestmark = pytest.mark.usefixtures("catalog")


def _term(values: list[str], negated: bool = False, matches_absent: bool = False) -> ConditionTerm:
    return ConditionTerm(fact_values=values, negated=negated, matches_absent=matches_absent)


def _class(label: str, sort_order: int, conditions=(), former_keys=()) -> RoadClass:
    return RoadClass(
        label=label, description=f"{label}の道", sort_order=sort_order, former_keys=list(former_keys), conditions=list(conditions)
    )


def _layer(group_key: str, sort_order: int, palette: str = "ordered", hue_slot: int | None = None, tone=None, **fields) -> RoadMapLayer:
    return RoadMapLayer(
        group_key=group_key,
        sort_order=sort_order,
        icon_key="icon",
        summary=f"{group_key}{sort_order}の層",
        panel_hint="ヒント",
        palette=palette,
        hue_slot=hue_slot,
        tone=tone,
        no_data_fact_key=fields.get("no_data_fact_key"),
        hides_unclassified=fields.get("hides_unclassified", False),
    )


def _definitions(**fields) -> RoadClassDefinitions:
    return RoadClassDefinitions(
        classifications=fields.get("classifications", {}),
        map_layers=fields.get("map_layers", {}),
        rolling_resistance_classification=None,
        rolling_resistance_classes={},
        avoidance_sections=fields.get("avoidance_sections", {}),
        avoidance_classifications=fields.get("avoidance_classifications", {}),
    )


def _classification(classes: dict[str, RoadClass], is_published: bool = True) -> RoadClassification:
    return RoadClassification(label="分け方", description="", is_published=is_published, classes=classes)


def test_layers_are_published_and_ordered() -> None:
    """公開していない分け方の層は配らず、層は群・並びの順、区分は並びの順に出る（表の鍵の順に依らない）。"""
    classes = {"b": _class("B", 2), "a": _class("A", 1)}
    catalog = road_class_catalog(
        _definitions(
            classifications={
                "late": _classification(classes),
                "early": _classification(classes),
                "draft": _classification(classes, is_published=False),
            },
            map_layers={"late": _layer("g", 2), "early": _layer("g", 1), "draft": _layer("a", 0)},
        )
    )
    assert [layer.id for layer in catalog.map_layers] == ["early", "late"]
    assert [road_class.key for road_class in catalog.map_layers[0].classes] == ["a", "b"]


@pytest.mark.parametrize(
    ("layer", "colors", "description"),
    [
        (_layer("g", 0), ordered_colors(3), f"g0の層[{ordered_ends_phrase('A', 'C')}]"),
        (_layer("g", 0, "nominal", hue_slot=4, tone="pale"), nominal_colors(4, 3, "pale"), "g0の層[A・B・C]"),
    ],
)
def test_layer_colors_and_description_follow_palette(layer: RoadMapLayer, colors: list[str], description: str) -> None:
    """順序のある層は両端の文で、名前の層は区分の名前を並べて説明し、色は並びの順に配る。"""
    classes = {key: _class(key.upper(), position) for position, key in enumerate("abc")}
    (view,) = road_class_catalog(_definitions(classifications={"x": _classification(classes)}, map_layers={"x": layer})).map_layers
    assert [road_class.color for road_class in view.classes] == colors
    assert view.description == [description]


def test_class_conditions_are_resolved_to_tile_properties_and_notes() -> None:
    """条件の項はタイルのプロパティへ解き、タイルに載らない事実・知らない事実はnull（どの道にも事実が無い）で配る。"""
    road_class = _class(
        "A",
        0,
        conditions=[
            {"cat_a": _term(["x", "y"], negated=True, matches_absent=True), "cat_hidden": _term([], negated=True)},
            {"unknown": _term([], matches_absent=True)},
        ],
    )
    (view,) = road_class_catalog(
        _definitions(
            classifications={"x": _classification({"a": road_class})},
            map_layers={"x": _layer("g", 0, no_data_fact_key="cat_a")},
        )
    ).map_layers
    assert view.no_data_property == "kind"
    (class_view,) = view.classes
    assert [[term.property for term in condition] for condition in class_view.conditions] == [["kind", None], [None]]
    assert class_view.description == "Aの道[種別がx・y以外か無い かつ 隠れがある、またはunknownが無い]"


def test_avoidance_rows_apply_overrides() -> None:
    """除外の行は、上書きの無い区分を分け方の見出しに「通る」で出し、選べない区分は出さない。"""
    classes = {"plain": _class("P", 0), "moved": _class("M", 1), "hidden": _class("H", 2)}
    catalog = road_class_catalog(
        _definitions(
            classifications={"x": _classification(classes), "draft": _classification(classes, is_published=False)},
            avoidance_sections={"main": AvoidanceSection(label="主", description="", sort_order=0)},
            avoidance_classifications={
                "x": AvoidanceClassification(
                    section_key="main",
                    sort_order=0,
                    overrides={
                        "moved": AvoidanceOverride(section_key="other", default_level="avoid", selectable=True),
                        "hidden": AvoidanceOverride(section_key=None, default_level=None, selectable=False),
                    },
                ),
                "draft": AvoidanceClassification(section_key="main", sort_order=1, overrides={}),
            },
        )
    )
    assert [(row.key, row.section, row.default) for row in catalog.avoidance.rows] == [
        ("x.plain", "main", "pass"),
        ("x.moved", "other", "avoid"),
    ]
