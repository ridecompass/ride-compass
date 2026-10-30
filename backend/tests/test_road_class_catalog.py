"""道の区分を軸カタログで配る形（`domain/road_class_catalog.py: road_class_catalog`）を見る。

ここで見ないもの:
- 区分に道を振り分ける式と、地図の線の層の値 → `test_road_classes.py`
- 色そのものの作り方（`domain/display_palette.py`） → `test_display_palette.py`
- 表との往復と、応答のどこへ出るか → `test_road_class_admin_routes.py`
"""

from app.domain.road_class_catalog import road_class_catalog
from app.domain.map_display import MAP_LAYER_CATEGORIES
from app.domain.road_classes import AvoidanceClassification, AvoidanceOverride
from tests.road_class_fixture import classification, fact_is, map_layer, road_classes


def test_layers_are_published_and_ordered() -> None:
    """公開していない分け方の層は配らず、層は画面の群の並び→層の並びの順、区分は並びの順に出る（表の鍵の順・群の鍵の綴りの順に
    依らない）。"""
    first, second = (category.key for category in MAP_LAYER_CATEGORIES[:2])
    kinds = classification({"b": [], "a": []})
    catalog = road_class_catalog(
        road_classes(
            {"late": kinds, "early": kinds, "other": kinds, "draft": kinds.model_copy(update={"is_published": False})},
            map_layers={
                "late": map_layer(2).model_copy(update={"group_key": first}),
                "early": map_layer(1).model_copy(update={"group_key": first}),
                "other": map_layer(0).model_copy(update={"group_key": second}),
                "draft": map_layer(0).model_copy(update={"group_key": first}),
            },
        )
    )
    assert [(layer.id, [c.key for c in layer.classes]) for layer in catalog.map_layers] == [
        ("early", ["b", "a"]),
        ("late", ["b", "a"]),
        ("other", ["b", "a"]),
    ]


def test_class_description_is_the_meaning_without_its_conditions() -> None:
    """凡例の区分と除外の行の説明は意味の文だけで、条件（どのタグの道か）を含めない（条件は管理の経路でだけ見せる）。"""
    kinds = classification({"a": [fact_is("cat_a", "x")]})
    meant = kinds.classes["a"].model_copy(update={"description": "意味の文"})
    catalog = road_class_catalog(
        road_classes(
            {"k": kinds.model_copy(update={"classes": {"a": meant}})},
            map_layers={"k": map_layer()},
            avoidance_classifications={"k": AvoidanceClassification(overrides={})},
        )
    )
    (layer,) = catalog.map_layers
    (row,) = catalog.avoidance.rows
    assert (layer.classes[0].description, row.description) == ("意味の文", "意味の文")


def test_avoidance_rows_are_grouped_under_their_map_layers() -> None:
    """除外の行は分け方ごとの見出し（名前は分け方の名前）にまとまり、見出しは層の並び、行は区分の並びに出る。上書きの無い区分は
    「通る」で出し、選べない区分・公開していない分け方・地図の層でない分け方・行の無い見出しは出さない。"""
    kinds = classification({"plain": [], "avoided": [], "hidden": []})
    catalog = road_class_catalog(
        road_classes(
            {
                "x": kinds.model_copy(update={"label": "分け方X"}),
                "y": kinds.model_copy(update={"label": "分け方Y"}),
                "closed": kinds,
                "draft": kinds.model_copy(update={"is_published": False}),
                "unmapped": kinds,
            },
            map_layers={"x": map_layer(2), "y": map_layer(1), "closed": map_layer(3), "draft": map_layer(0)},
            avoidance_classifications={
                "x": AvoidanceClassification(
                    overrides={
                        "avoided": AvoidanceOverride(default_level="avoid", selectable=True),
                        "hidden": AvoidanceOverride(default_level=None, selectable=False),
                    },
                ),
                "y": AvoidanceClassification(overrides={}),
                "closed": AvoidanceClassification(
                    overrides={key: AvoidanceOverride(default_level=None, selectable=False) for key in kinds.classes},
                ),
                "draft": AvoidanceClassification(overrides={}),
                "unmapped": AvoidanceClassification(overrides={}),
            },
        )
    )
    assert [(section.key, section.label) for section in catalog.avoidance.sections] == [("y", "分け方Y"), ("x", "分け方X")]
    assert [(row.key, row.section, row.default) for row in catalog.avoidance.rows] == [
        ("y.plain", "y", "pass"),
        ("y.avoided", "y", "pass"),
        ("y.hidden", "y", "pass"),
        ("x.plain", "x", "pass"),
        ("x.avoided", "x", "avoid"),
    ]
