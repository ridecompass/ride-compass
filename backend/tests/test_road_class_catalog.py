"""道の区分を軸カタログで配る形（`domain/road_class_catalog.py: road_class_catalog`）を見る。

ここで見ないもの:
- 区分に道を振り分ける式と、地図の線の層の値 → `test_road_classes.py`
- 色そのものの作り方（`domain/display_palette.py`） → `test_display_palette.py`
- 表との往復と、応答のどこへ出るか → `test_road_class_admin_routes.py`
"""

from app.domain.road_class_catalog import road_class_catalog
from app.domain.road_classes import AvoidanceClassification, AvoidanceOverride, AvoidanceSection, ConditionTerm
from tests.road_class_fixture import classification, map_layer, road_classes


def test_layers_are_published_and_ordered() -> None:
    """公開していない分け方の層は配らず、層は並びの順、区分は並びの順に出る（表の鍵の順に依らない）。"""
    kinds = classification({"b": [], "a": []})
    catalog = road_class_catalog(
        road_classes(
            {"late": kinds, "early": kinds, "draft": kinds.model_copy(update={"is_published": False})},
            map_layers={"late": map_layer(2), "early": map_layer(1), "draft": map_layer(0)},
        )
    )
    assert [(layer.id, [c.key for c in layer.classes]) for layer in catalog.map_layers] == [
        ("early", ["b", "a"]),
        ("late", ["b", "a"]),
    ]


def test_class_description_notes_its_conditions() -> None:
    """区分の説明に、条件から組んだタグの注を足す（材料の宣言に無い事実は、材料のidのまま書く）。"""
    conditions = [
        {
            "cat_a": ConditionTerm(fact_values=["x", "y"], negated=True, matches_absent=True),
            "cat_b": ConditionTerm(fact_values=[], negated=True, matches_absent=False),
        },
        {"cat_c": ConditionTerm(fact_values=[], negated=False, matches_absent=True)},
    ]
    (layer,) = road_class_catalog(
        road_classes({"k": classification({"a": conditions})}, map_layers={"k": map_layer()})
    ).map_layers
    assert layer.classes[0].description == "[cat_aがx・y以外か無い かつ cat_bがある、またはcat_cが無い]"


def test_avoidance_rows_apply_overrides() -> None:
    """除外の行は、上書きの無い区分を分け方の見出しに「通る」で出し、選べない区分と公開していない分け方は出さない。"""
    kinds = classification({"plain": [], "moved": [], "hidden": []})
    catalog = road_class_catalog(
        road_classes(
            {"x": kinds, "draft": kinds.model_copy(update={"is_published": False})},
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
