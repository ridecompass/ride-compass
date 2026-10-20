"""`domain/axis_definitions.py`——軸が軸を読む階層と、軸の集合（`AXIS_DEFINITIONS`）を相手にする入口。

入口: 依存の解決（`axis_dependencies`・`topological_axis_order`・`dynamic_axis_topological_order`）・全軸の評価
（`evaluate_axes_array`・`evaluate_axes_values`・`evaluate_axes_inputs`）・葉の材料の一次属性（`primary_attribute_ids_for`）・
葉の材料で区分の決まる道の線の層（`road_layer_ids_for`）・時間帯で効く重み（`time_scoped_weights`）。

ここで見ないもの:
- 軸1本の宣言の検証・評価（折れ点・欠損・対応表・0次条件）と書き込みのガード → `test_axis_definitions.py`
- 循環を管理APIが拒むこと・書いた後の全軸を読み込みと同じ判定へ通すこと → `test_axis_registry_service.py`
- 軸カタログが配る一次属性と気象のチップ → `test_axis_catalog_routes.py`
- 既定の重み（`default_axis_weights`） → 重みを読む側（`test_route_preference.py`）
- `evaluate_axes_values`が返す軸の並び——読み手の区間インスペクタは軸の id で引き、画面は軸カタログの順で出すので、
  並びは外へ出ない（依存の順に評価することは、軸を読む軸の値が出ることが示す）

**材料カタログと軸の集合は差し替える。** 軸の参照か材料かは材料カタログにあるかで決まるので、葉の材料だけを持つ
架空のカタログを与える。軸の集合は見たい階層だけをテストごとに組み立てる。
"""

import numpy as np
import pytest

from app.domain import axis_definitions, material_catalog
from app.domain.axis_definitions import (
    AxisDefinition,
    BreakpointLinearShape,
    CategoricalShape,
    MaterialTerm,
    PriorityCondition,
)
from app.domain.primary_attributes import PRIMARY_ATTRIBUTES
from tests.axis_system_fixture import replaced_axis_definitions
from tests.road_class_fixture import classification, fact_is, map_layer, road_classes

ATTR_X, ATTR_Y = PRIMARY_ATTRIBUTES[:2]
DYNAMIC = next(iter(axis_definitions.REQUEST_DYNAMIC_MATERIAL_IDS))

pytestmark = pytest.mark.usefixtures("catalog")


def material(material_id: str, dtype="numeric", primary_attribute=None, source="db") -> material_catalog.MaterialSpec:
    return material_catalog.MaterialSpec(
        material_id=material_id,
        label=material_id,
        description=material_id,
        dtype=dtype,
        tile_property=None,
        source=source,
        value_sql=f"w.{material_id}" if source == "db" else None,
        coverage=material_catalog.CoverageExcluded(reason="テスト用", missing_semantics="unknown"),
        primary_attribute=primary_attribute,
    )


@pytest.fixture
def catalog(monkeypatch):
    specs = {
        "num_a": material("num_a", primary_attribute=ATTR_X),
        "num_b": material("num_b", primary_attribute=ATTR_Y),
        "num_c": material("num_c", primary_attribute=ATTR_X),
        "num_plain": material("num_plain"),
        "cat": material("cat", dtype="categorical"),
        DYNAMIC: material(DYNAMIC, source="request"),
    }
    monkeypatch.setattr(material_catalog, "MATERIAL_CATALOG", specs)


def axis(axis_id: str, *refs: str, published: bool = False, **fields) -> AxisDefinition:
    """`refs`を重み1で足し、0〜10を0〜100へ写す軸。"""
    shape = BreakpointLinearShape(
        terms=[MaterialTerm(material=ref) for ref in refs or ("num_a",)], breakpoints=[(0.0, 0.0), (10.0, 100.0)]
    )
    return AxisDefinition(
        axis_id=axis_id, shape=shape, is_published=published, **{"default_weight": 1.0, "label": axis_id, **fields}
    )


def axes(*definitions: AxisDefinition) -> dict[str, AxisDefinition]:
    return {d.axis_id: d for d in definitions}


class TestDependencies:
    @pytest.mark.parametrize(
        ("definition", "known", "expected"),
        [
            (
                axis("outer", "num_a", "inner", priority_overrides=[PriorityCondition(material="flag_axis", equals="x", value=0.0)]),
                {"inner", "flag_axis", "outer"},
                {"inner", "flag_axis"},
            ),
            (axis("outer", "inner"), {"outer"}, set()),
            (axis("outer", "num_a"), {"num_a", "outer"}, set()),
        ],
        ids=["known-axes", "unknown-axis", "also-a-material"],
    )
    def test_the_known_axes_an_axis_reads_other_than_materials_are_its_dependencies(self, definition, known, expected):
        assert axis_definitions.axis_dependencies(definition, known) == expected


class TestTopologicalOrder:
    def test_a_cycle_is_refused_naming_the_axes_around_it(self):
        with pytest.raises(axis_definitions.AxisDependencyCycleError) as caught:
            axis_definitions.topological_axis_order(axes(axis("a", "b"), axis("b", "a")))

        assert caught.value.cycle == ["a", "b", "a"]
        assert "「a」→「b」→「a」" in str(caught.value)


class TestDynamicOrder:
    def test_only_axes_reading_an_hourly_material_directly_or_through_axes_are_listed_in_order(self):
        definitions = axes(
            axis("outer", "num_b", "middle"),
            axis("static", "num_a"),
            axis("middle", "wind"),
            axis("wind", DYNAMIC),
        )

        assert axis_definitions.dynamic_axis_topological_order(definitions) == ["wind", "middle", "outer"]


class TestEvaluateAllAxes:
    def test_python_values_give_published_axes_only(self):
        definitions = axes(
            axis("outer", "inner", published=True), axis("plain", "num_b", published=True), axis("inner", "num_a")
        )

        with replaced_axis_definitions(definitions):
            result = axis_definitions.evaluate_axes_values({"num_a": [0.5, None], "num_b": [1.0, 1.0]}, 2)

        assert result == {"outer": [50.0, None], "plain": [10.0, 10.0]}

    def test_inputs_are_the_raw_sum_or_the_looked_up_value_of_each_published_axis(self):
        definitions = axes(
            axis("outer", "inner", "num_b", published=True),
            AxisDefinition(
                axis_id="kind",
                shape=CategoricalShape(material="cat", mapping={"x": 10.0}),
                default_weight=1.0,
                label="kind",
                is_published=True,
            ),
            axis("inner", "num_a"),
        )

        with replaced_axis_definitions(definitions):
            inputs = axis_definitions.evaluate_axes_inputs(
                {"num_a": [0.5, None], "num_b": [1.0, 2.0], "cat": ["y", None]}, 2
            )

        assert inputs == {"outer": [6.0, None], "kind": ["y", None]}


class TestPrimaryAttributes:
    def test_the_attributes_of_the_leaf_materials_are_listed_once_through_the_axes_read(self):
        definitions = axes(axis("outer", "num_b", "inner", "num_c"), axis("inner", "num_a", "num_plain", "unknown"))

        with replaced_axis_definitions(definitions):
            assert axis_definitions.primary_attribute_ids_for(definitions["outer"]) == [ATTR_Y.attr_id, ATTR_X.attr_id]


class TestRoadLayers:
    def test_the_layers_drawn_from_a_published_classification_that_decides_by_a_leaf_material_are_listed(self):
        """軸のレンズで地図に出す道の層を選ぶ。読む材料と無関係な層を出すと、軸と関係の無い線が重なる。区分の列を読む軸は、
        その分け方が読む事実を区分の決め手にする層も見ている（路面の見込みを読む軸は、路面の層を見ている）。"""
        definitions = axes(axis("outer", "inner", "class:by_its_classes"), axis("inner", "num_a"))
        draft = classification({"x": [fact_is("num_a", "v")]}).model_copy(update={"is_published": False})
        layers = ["draft", "by_unread", "by_inner_leaf", "by_its_classes", "by_class_facts"]
        classes = road_classes(
            {
                "by_inner_leaf": classification({"x": [fact_is("num_b", "v")], "y": [fact_is("num_a", "v")]}),
                "by_unread": classification({"x": [fact_is("num_d", "v")]}),
                "by_its_classes": classification({"x": [fact_is("num_e", "v")]}),
                "by_class_facts": classification({"x": [fact_is("num_e", "v")]}),
                "draft": draft,
                "not_drawn": classification({"x": [fact_is("num_a", "v")]}),
            },
            map_layers={key: map_layer(n) for n, key in enumerate(layers)},
        )

        with replaced_axis_definitions(definitions):
            assert axis_definitions.road_layer_ids_for(definitions["outer"], classes) == [
                "by_inner_leaf",
                "by_its_classes",
                "by_class_facts",
            ]


class TestWeights:
    def test_an_axis_with_a_time_scope_weighs_only_on_the_segments_ridden_in_it(self):
        definitions = axes(axis("always"), axis("night", time_scope="night_only"))
        weights = {"always": 1.0, "night": 3.0}

        with replaced_axis_definitions(definitions):
            scoped = axis_definitions.time_scoped_weights(weights, {"night_only": np.array([False, True])})
            outside_every_scope = axis_definitions.time_scoped_weights(weights, {})

        assert scoped["always"] == 1.0 and scoped["night"].tolist() == [0.0, 3.0]
        assert outside_every_scope == {"always": 1.0, "night": 0.0}
        assert weights == {"always": 1.0, "night": 3.0}
