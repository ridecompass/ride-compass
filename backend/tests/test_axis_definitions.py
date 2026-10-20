"""`domain/axis_definitions.py`——軸1本の宣言（モデルの検証・軸の外に照らす検査・書き込みのガード）と、軸1本の評価。

入口:
- モデルの組み立て（`AxisDefinition`・`BreakpointLinearShape`・`CategoricalShape`。管理APIの本文もDBの行もここを通る）
- 密度の軸の見分け（`averages_density`）
- 軸の外に照らす検査（`check_axis_definition`）・軸の集合の検査（`check_axis_set`）と書き込みのガード
  （`check_publish_immutability`・`check_material_exclusivity`・`check_internal_axis_not_published`）
- 区分を入れ替えるときに軸を照らす判定（`unknown_class_values`）
- 軸1本の評価（`evaluate_axis_array`）と生値（`axis_raw_value_array`・`raw_values`・
  `BreakpointLinearShape.score_at`）と、点数から値の大きさへの戻し（`BreakpointLinearShape.smallest_magnitude_at`）

ここで見ないもの:
- 軸が軸を参照するときの並べ替え・軸の集合の評価・既定の重みと時間帯 → `test_axis_hierarchy.py`
- 折れ線の補間と対応表の引き方そのもの → `test_axis_templates.py`
- 難易度の桁への丸めの中身 → `test_difficulty.py`
- 検証の誤り・断りを管理APIが422・409で返すこと → `test_axis_admin_routes.py`
- 軸カタログが配る一次属性と気象のチップ → `test_axis_catalog_routes.py`

**材料カタログは差し替える。** 軸の外に照らす検査が見るのは材料の型と表示名だけなので、その性質だけを持つ
架空の材料を与える。評価はカタログを読まない。
"""

import math
from contextlib import nullcontext

import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st
from pydantic import ValidationError
from pydantic_core import PydanticCustomError

from app.domain import axis_definitions
from app.domain.attributes import CategoricalColumn
from app.domain.axis_definitions import (
    AxisDefinition,
    BreakpointLinearShape,
    CategoricalShape,
    MaterialTerm,
    PriorityCondition,
)
from app.domain.road_classes import class_material_id
from tests.axis_system_fixture import linear, shaped_axis
from tests.material_fixture import material, replace_material_catalog
from tests.road_class_fixture import classification, road_classes

NAN = float("nan")
DYNAMIC = next(iter(axis_definitions.REQUEST_DYNAMIC_MATERIAL_IDS))


@pytest.fixture
def catalog(monkeypatch):
    return replace_material_catalog(monkeypatch, [
        material("num_a", label="数値A"),
        material("num_b", label="数値B"),
        material("count_a", label="回数A", additive=True),
        material("count_b", label="回数B", additive=True),
        material("flag", "boolean", label="旗"),
        material("cat", "categorical", label="種類"),
        material(DYNAMIC, label="時刻の材料", source="request"),
    ])


def axis(axis_id: str = "axis_a", shape=None, **fields) -> AxisDefinition:
    return AxisDefinition(
        axis_id=axis_id,
        shape=shape if shape is not None else linear(MaterialTerm(material="num_a")),
        **{"default_weight": 1.0, "label": "軸", **fields},
    )


def axis_errors(error: ValidationError) -> list[tuple[str, str]]:
    return [(e["type"], e["msg"]) for e in error.errors()]


def assert_refused(make, fragment: str) -> None:
    """検証の誤りは管理画面にそのまま出るので、前置きの無い日本語の文1件で返る。"""
    with pytest.raises(ValidationError) as caught:
        make()
    [(kind, message)] = axis_errors(caught.value)
    assert kind == "axis_definition"
    assert fragment in message


class TestShapeModels:
    def test_breakpoints_must_rise_strictly_along_the_value_axis(self):
        assert_refused(lambda: linear(MaterialTerm(material="m"), breakpoints=[(0.0, 0.0), (0.0, 50.0)]), "小さい順")

    def test_an_empty_mapping_is_refused(self):
        assert_refused(lambda: CategoricalShape(material="m", mapping={}), "1件")

    @pytest.mark.parametrize(
        ("shape", "expected"),
        [
            ({"material": "m", "mapping": {"x": 1.0}}, CategoricalShape),
            ({"terms": [{"material": "m"}], "breakpoints": [[0.0, 0.0]]}, BreakpointLinearShape),
        ],
    )
    def test_a_shape_without_its_kind_is_told_apart_by_its_contents(self, shape, expected):
        definition = AxisDefinition.model_validate({"axis_id": "a", "label": "軸", "default_weight": 1.0, "shape": shape})

        assert isinstance(definition.shape, expected)


class TestAxisModel:
    def test_an_empty_label_is_refused(self):
        assert_refused(lambda: axis(label=""), "表示名")

    @pytest.mark.parametrize(("thresholds", "fragment"), [([], "1件以上"), ([10.0, 10.0], "小さい順")])
    def test_overridden_thresholds_must_be_present_and_rise_strictly(self, thresholds, fragment):
        assert_refused(lambda: axis(display_thresholds_override=thresholds), fragment)

    def test_band_labels_need_overridden_thresholds(self):
        assert_refused(lambda: axis(display_band_labels_override=["弱", "強"]), "しきい値も上書き")

    def test_band_labels_must_match_the_number_of_bands(self):
        assert_refused(
            lambda: axis(display_thresholds_override=[1.0, 2.0], display_band_labels_override=["弱", "強"]), "3件"
        )

    @pytest.mark.parametrize(
        ("shape", "expected"),
        [
            (linear(MaterialTerm(material="num_b"), MaterialTerm(material="flag")), ["num_b", "flag", "cat"]),
            (CategoricalShape(material="cat", mapping={"x": 1.0}), ["cat", "flag"]),
        ],
    )
    def test_materials_list_the_shape_then_the_conditions_once_each(self, shape, expected):
        definition = axis(
            shape=shape,
            priority_overrides=[
                PriorityCondition(material="cat", equals="x", value=0.0),
                PriorityCondition(material="flag", equals="true", value=0.0),
            ],
        )

        assert definition.materials == expected


def refused_by_check(definition: AxisDefinition, fragment: str | None, axes=None) -> None:
    """`fragment`がNoneなら、検査が通ることを見る。"""
    if fragment is None:
        axis_definitions.check_axis_definition(definition, axes or {})
        return
    with pytest.raises(PydanticCustomError) as caught:
        axis_definitions.check_axis_definition(definition, axes or {})
    assert caught.value.type == "axis_definition"
    assert fragment in str(caught.value)


@pytest.mark.usefixtures("catalog")
class TestCheckAxisDefinition:
    @pytest.mark.parametrize(
        ("definition", "fragment"),
        [
            (axis(shape=linear(MaterialTerm(material=DYNAMIC), MaterialTerm(material="num_a"))), "「数値A」"),
            (
                axis(
                    shape=linear(MaterialTerm(material=DYNAMIC)),
                    priority_overrides=[PriorityCondition(material="flag", equals="true", value=0.0)],
                ),
                "「旗」",
            ),
        ],
        ids=["term", "condition"],
    )
    def test_materials_that_change_by_the_hour_are_not_mixed_with_static_ones(self, definition, fragment):
        refused_by_check(definition, fragment)

    def test_a_reference_that_is_neither_a_material_nor_a_given_axis_is_refused_by_its_id(self):
        refused_by_check(axis(shape=linear(MaterialTerm(material="nowhere"))), "nowhere")

    @pytest.mark.parametrize(
        ("shape", "fragment"),
        [
            (linear(MaterialTerm(material="cat")), "「種類」"),
            (CategoricalShape(material="num_a", mapping={"1": 1.0}), "「数値A」"),
        ],
    )
    def test_a_material_of_a_type_the_shape_cannot_read_is_refused_by_its_name(self, shape, fragment):
        refused_by_check(axis(shape=shape), fragment)

    @pytest.mark.parametrize(
        ("material_id", "mapping", "fragment"),
        [
            ("flag", {"yes": 1.0}, "「はい」「いいえ」"),
            ("cat", {"true": 1.0}, "値の名前"),
            ("flag", {"true": 1.0}, None),
            ("cat", {"x": 1.0}, None),
        ],
    )
    def test_mapping_keys_must_be_of_the_materials_type(self, material_id, mapping, fragment):
        refused_by_check(axis(shape=CategoricalShape(material=material_id, mapping=mapping)), fragment)

    @pytest.mark.parametrize(
        ("condition", "fragment"),
        [
            (PriorityCondition(material="nowhere", equals="true", value=0.0), "nowhere"),
            (PriorityCondition(material="other_axis", equals="true", value=0.0), "軸です"),
            (PriorityCondition(material="num_a", equals="true", value=0.0), "数値の材料"),
            (PriorityCondition(material="flag", equals="yes", value=0.0), "「yes」"),
            (PriorityCondition(material="cat", equals="true", value=0.0), "「true」"),
            (PriorityCondition(material="flag", equals="true", value=0.0), None),
            (PriorityCondition(material="cat", equals="residential", value=0.0), None),
        ],
    )
    def test_a_condition_that_can_match_no_road_is_refused(self, condition, fragment):
        definition = axis(priority_overrides=[condition])

        refused_by_check(definition, fragment, axes={"other_axis": axis("other_axis", label="ほかの軸")})

    @pytest.mark.parametrize(
        ("terms", "breakpoints", "fragment"),
        [
            ([MaterialTerm(material="count_a"), MaterialTerm(material="count_b", weight=2.5)],
             [(0.0, 0.0), (2.0, 35.0), (10.0, 100.0)], "「0のとき0点」ともう1点"),
            ([MaterialTerm(material="count_a"), MaterialTerm(material="count_b", weight=2.5)],
             [(1.0, 0.0), (10.0, 100.0)], "「0のとき0点」ともう1点"),
            ([MaterialTerm(material="count_a")], [(0.0, 0.0), (8.0, 100.0)], None),
            ([MaterialTerm(material="count_a"), MaterialTerm(material="num_a")], [(0.0, 0.0), (2.0, 35.0), (10.0, 100.0)],
             None),
        ],
        ids=["上に凸の折れ線", "0で0点から始まらない直線", "回数だけの軸の0からの直線", "回数でない材料も読む軸の折れ線"],
    )
    def test_an_axis_summing_only_counts_per_km_must_score_in_proportion_to_the_count(self, terms, breakpoints, fragment):
        """探索の費用は回数×傾きで足すので、傾きが1つに決まらない折れ線では、探索とルートの値が食い違い、点数の和が道の
        切り方で変わる。"""
        refused_by_check(axis(shape=linear(*terms, breakpoints=breakpoints)), fragment)


@pytest.mark.usefixtures("catalog")
@pytest.mark.parametrize(
    ("definition", "averaged"),
    [
        # 重みが1でない項を持つ。
        (axis(shape=linear(MaterialTerm(material="count_a"), MaterialTerm(material="count_b", weight=2.5))), True),
        # 重み0の項は読まない。
        (axis(shape=linear(MaterialTerm(material="count_a"), MaterialTerm(material="num_a", weight=0.0))), True),
        # 密度でない材料（勾配の%等）を読む。
        (axis(shape=linear(MaterialTerm(material="count_a"), MaterialTerm(material="num_a"))), False),
        # 他の軸を項に持つ（中の軸の点数は密度でない）。
        (axis(shape=linear(MaterialTerm(material="count_a"), MaterialTerm(material="other_axis"))), False),
        (axis(shape=linear(MaterialTerm(material="count_a"), preprocess="abs")), False),
        (axis(shape=CategoricalShape(material="cat", mapping={"x": 50.0})), False),
    ],
    ids=["停止密度", "重み0の項", "密度でない材料", "他の軸", "前処理abs", "対応表の軸"],
)
def test_only_axes_reading_counts_per_km_as_they_are_are_density_axes(definition, averaged):
    """密度の軸は、ビンと候補の点数を回数の平均から作り、探索の費用では回数の足し算として持つ。密度でない値を
    平均すると、短い急坂のような区間のつらさがならされて消える。"""
    assert axis_definitions.averages_density(definition) is averaged


NEW_BREAKPOINTS = ((0.0, 0.0), (5.0, 100.0))


SHOWN_DIFFERENTLY = {
    "shape": linear(MaterialTerm(material="num_a"), breakpoints=((0.0, 0.0), (5.0, 60.0), (20.0, 100.0))),
    "icon_id": "icon",
    "display_thresholds_override": [1.0],
    "display_band_labels_override": ["弱", "強"],
}
UPDATE_REFUSED = "表示と折れ点以外は変えられません"


class TestPublishImmutability:
    @pytest.mark.parametrize(
        ("action", "changed", "refusal"),
        [
            ("deleted", None, "「軸」は公開中のため削除できません"),
            # 公開したまま書けないと、下書きへ戻す間だけ一般の画面から軸が消え、利用者の重みが既定へ戻る。
            ("updated", SHOWN_DIFFERENTLY, None),
            # 折れ点は、ほかを変えない差し替えのときだけ公開したまま書ける。
            ("updated", {"default_weight": 2.0, "shape": linear(MaterialTerm(material="num_a"), breakpoints=NEW_BREAKPOINTS)},
             UPDATE_REFUSED),
            ("updated", {"shape": linear(MaterialTerm(material="num_b"), breakpoints=NEW_BREAKPOINTS)}, UPDATE_REFUSED),
            ("updated", {"shape": linear(MaterialTerm(material="num_a", weight=2.0), breakpoints=NEW_BREAKPOINTS)},
             UPDATE_REFUSED),
            ("updated", {"shape": linear(MaterialTerm(material="num_a"), breakpoints=NEW_BREAKPOINTS, preprocess="abs")},
             UPDATE_REFUSED),
            ("updated", {"shape": CategoricalShape(material="num_a", mapping={"x": 50.0})}, UPDATE_REFUSED),
            ("updated", {"is_published": False, "shape": linear(MaterialTerm(material="num_a"), breakpoints=NEW_BREAKPOINTS)},
             UPDATE_REFUSED),
        ],
        ids=["削除", "表示と折れ点", "重み", "材料", "項", "前処理", "形の種類", "公開"],
    )
    def test_a_published_axis_may_change_only_how_it_is_shown_and_its_breakpoints(self, action, changed, refusal):
        published = axis(is_published=True)
        candidate = None if changed is None else published.model_copy(update=changed)

        with nullcontext() if refusal is None else pytest.raises(axis_definitions.AxisPublishedImmutableError, match=refusal):
            axis_definitions.check_publish_immutability(published, action, candidate)


@pytest.mark.usefixtures("catalog")
class TestMaterialExclusivity:
    def test_a_material_already_counted_by_another_axis_is_refused(self):
        existing = {"axis_b": axis("axis_b", label="先の軸", shape=linear(MaterialTerm(material="num_a")))}
        candidate = axis("axis_a", shape=linear(MaterialTerm(material="num_a"), MaterialTerm(material="num_b")))

        with pytest.raises(axis_definitions.AxisMaterialConflictError) as caught:
            axis_definitions.check_material_exclusivity(candidate, existing)

        error = caught.value
        assert (error.axis_id, error.conflicting_axis_id, error.overlapping_materials) == ("axis_a", "axis_b", {"num_a"})
        assert "「数値A」" in str(error) and "「先の軸」" in str(error)


@pytest.mark.usefixtures("catalog")
class TestAxisSet:
    @pytest.mark.parametrize(
        ("definitions", "refusal"),
        [
            ({"num_b": axis("num_b")}, "材料idと衝突"),
            ({"axis_b": axis("axis_b"), "axis_a": axis("axis_a")}, "すでに軸「軸」が使っています"),
            (
                {
                    "axis_a": axis("axis_a", shape=linear(MaterialTerm(material="axis_b"))),
                    "axis_b": axis("axis_b", shape=linear(MaterialTerm(material="axis_a"))),
                },
                "輪になっています",
            ),
            # 時刻で変わる軸は公開軸の点数しか受け取れないので、変わらない部分を公開軸にして組み合わせる。
            (
                {
                    "still": axis("still", is_published=True),
                    "wind": axis("wind", shape=linear(MaterialTerm(material=DYNAMIC), MaterialTerm(material="still"))),
                },
                None,
            ),
        ],
        ids=[
            "axis_id_is_a_material_id",
            "two_axes_count_one_material",
            "axes_combine_in_a_cycle",
            "a_published_axis_another_axis_combines",
        ],
    )
    def test_a_set_breaking_an_invariant_is_refused(self, definitions, refusal):
        with nullcontext() if refusal is None else pytest.raises(ValueError, match=refusal):
            axis_definitions.check_axis_set(definitions)


@pytest.mark.usefixtures("catalog")
class TestInternalAxisPublish:
    EXISTING = {"outer": axis("outer", label="外の軸", shape=linear(MaterialTerm(material="inner")))}

    @pytest.mark.parametrize(
        ("previous", "refused"),
        [
            ({}, True),
            ({"inner": axis("inner")}, True),
            # 時刻で変わる軸が組み合わせる公開軸の、表示だけの直し。公開へ切り替える書き込みではない。
            ({"inner": axis("inner", is_published=True)}, False),
        ],
        ids=["new", "draft", "already_published"],
    )
    def test_an_axis_another_axis_reads_is_not_published(self, previous, refused):
        candidate = axis("inner", is_published=True, icon_id="内")
        refusal = pytest.raises(axis_definitions.AxisInternalAxisPublishError, match="「軸」は「外の軸」が組み合わせに使っている軸")
        with refusal if refused else nullcontext():
            axis_definitions.check_internal_axis_not_published(candidate, {**self.EXISTING, **previous})


#: 分け方`k`は、区分`paved`（前の鍵`k.sealed`と、ほかの分け方を指す`other.gravel`を持つ）と`unpaved`。
RENAMED = road_classes({"k": classification({"paved": [], "unpaved": []}, former_keys={"paved": ["k.sealed", "other.gravel"]})})


@pytest.mark.parametrize(
    ("material_id", "mapping", "equals", "unknown"),
    [
        (class_material_id("k"), {"paved": 1.0, "sealed": 2.0}, "unpaved", []),
        # 前の鍵がほかの分け方を指す名は、この分け方の列の値だったことが無い。
        (class_material_id("k"), {"gravel": 1.0}, "unpaved", [(class_material_id("k"), "gravel")]),
        (class_material_id("k"), {"paved": 1.0}, "dirt", [(class_material_id("k"), "dirt")]),
        # 分け方の無い材料と、区分から作らない材料は見ない。
        (class_material_id("gone"), {"x": 1.0}, "x", []),
        ("cat_a", {"x": 1.0}, "x", []),
    ],
)
def test_class_values_named_by_neither_current_nor_former_keys(material_id, mapping, equals, unknown):
    """値ごとの点数のキーと0次条件の値のうち、今の区分の鍵にも前の鍵の区分の名にも無いものを挙げる（区分の入れ替えが断る文になる）。"""
    axis = shaped_axis(
        CategoricalShape(material=material_id, mapping=mapping),
        priority_overrides=[PriorityCondition(material=material_id, equals=equals, value=0.0)],
    )
    assert axis_definitions.unknown_class_values(axis, RENAMED) == unknown


def scores(values) -> list:
    """NaNをNoneへ（配列の比較を読みやすくする）。"""
    return [None if math.isnan(v) else v for v in np.asarray(values, dtype=float).tolist()]


class TestBreakpointScores:
    def test_a_missing_optional_material_adds_nothing(self):
        shape = linear(MaterialTerm(material="a", weight=2.0), MaterialTerm(material="b", required=False))

        result = axis_definitions.evaluate_axis_array(axis(shape=shape), {"a": np.array([2.0]), "b": np.array([NAN])})

        assert scores(result) == [40.0]

    def test_a_road_with_every_material_missing_is_unscored_even_when_all_are_optional(self):
        shape = linear(MaterialTerm(material="a", required=False), MaterialTerm(material="b", required=False))

        result = axis_definitions.evaluate_axis_array(
            axis(shape=shape), {"a": np.array([NAN, NAN]), "b": np.array([NAN, 0.0])}
        )

        assert scores(result) == [None, 0.0]

    @given(
        st.lists(st.integers(-1000, 1000), min_size=1, max_size=6, unique=True),
        st.lists(st.floats(0.0, 100.0), min_size=6, max_size=6),
        st.floats(0.0, 1100.0),
    )
    def test_a_magnitude_given_back_for_a_score_has_that_score(self, xs, ys, x):
        """引いた地図の勾配の道は、畳んだ点数をこの値へ戻して塗る。戻した値の点数が違うと、道が別の段の色になる。"""
        points = list(zip(sorted(float(v) for v in xs), ys))
        shape = linear(MaterialTerm(material="a"), breakpoints=points, preprocess="abs")
        score = shape.score_at(x)

        magnitude = shape.smallest_magnitude_at(score)

        assert magnitude >= 0.0
        assert shape.score_at(magnitude) == score


class TestPriorityConditions:
    def test_the_first_matching_condition_in_order_wins(self):
        definition = axis(
            priority_overrides=[
                PriorityCondition(material="flag", equals="true", value=1.0),
                PriorityCondition(material="cat", equals="x", value=2.0),
            ]
        )

        result = axis_definitions.evaluate_axis_array(
            definition,
            {"num_a": np.zeros(3), "flag": np.array([1.0, 0.0, NAN]), "cat": CategoricalColumn.encode(["x", "x", "y"])},
        )

        assert scores(result) == [1.0, 2.0, 0.0]


class TestRawValues:
    def test_a_mapping_axis_has_no_raw_value(self):
        shape = CategoricalShape(material="cat", mapping={"x": 1.0})

        assert axis_definitions.axis_raw_value_array(axis(shape=shape), {"cat": np.array(["x"], dtype=object)}) is None
        assert axis_definitions.raw_values(shape, {"cat": ["x", "y"]}, 2) == [None, None]
