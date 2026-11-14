"""`domain/material_catalog.py`——材料の宣言と、宣言から導く一覧・判定。

入口は次のとおり。
- `MaterialSpec`: dtypeと噛み合わない宣言を断る・表示用の名前
- カタログから導く一覧: `material_dtype`・`material_array_columns`（`material_value_sql`を通る）・
  `material_coverage_specs`・`material_coverage_exclusions`
- `display_axis_missing_semantics`: 地図の表示の軸の値が欠けたときの意味
- `check_material_catalog`: 材料を2通りに配るカタログを断る

カタログの中身は架空の材料（`num_a` 等）へ差し替えて与える。本番のカタログは、読み込みの時点で`check_material_catalog`を通る。

ここで見ないもの:
- 材料の値を求めるSQLが返す値 → `test_material_values.py`
- 欠損率をDBで数えること → `test_material_coverage.py`
- 欠損率の見出しの表の過不足 → `test_material_coverage_spec.py`
- 一次属性の行に配る色 → `test_display_palette.py`
- 一次属性の表示の宣言の検証 → `test_registry.py`・`test_primary_attributes.py`
- 停止要因の点を地図でまとめるSQL（`stop_poi_map_group_sql`）→ タイルを焼くテスト（`test_road_graph_repository_contracts.py`）
- 材料の欠損割合を配るAPI → `test_material_catalog_routes.py`
"""

from collections.abc import Iterable
from contextlib import nullcontext

import pytest
from pydantic import ValidationError

from app.domain import material_catalog
from app.domain.material_catalog import MaterialDType, MaterialSpec
from app.domain.material_coverage_spec import CoverageExcluded, EdgeMaterialCoverageSpec, WayMaterialCoverageSpec
from app.domain.primary_attributes import PRIMARY_ATTRIBUTES

ATTR_A, ATTR_B = PRIMARY_ATTRIBUTES[:2]


def material(material_id: str, dtype: MaterialDType = "numeric", **fields) -> MaterialSpec:
    """中身がテストの主題でない材料を1つ作る。

    既定は型を満たすためだけの値（表示名はid・タイルに載せない・DBの道の列を読む・網羅の集計から外す）。
    DBに値を持たない材料（`source`が`db`でない）は値の式を持たない。見たい性質は呼び出し側が引数で書く。
    """
    db = fields.get("source", "db") == "db"
    return MaterialSpec(**{
        "material_id": material_id,
        "label": material_id,
        "description": "架空の材料",
        "dtype": dtype,
        "tile_property": None,
        "value_sql": f"w.{material_id}" if db else None,
        "coverage": CoverageExcluded(reason="架空", missing_semantics="definite"),
        **fields,
    })


def replace_material_catalog(monkeypatch: pytest.MonkeyPatch, specs: Iterable[MaterialSpec]) -> dict[str, MaterialSpec]:
    """テストの間だけ材料カタログを`specs`だけにする（同じidは後のものが勝つ）。差し替えた中身を返す。"""
    catalog = {spec.material_id: spec for spec in specs}
    monkeypatch.setattr(material_catalog, "MATERIAL_CATALOG", catalog)
    return catalog


WAY_UNKNOWN = WayMaterialCoverageSpec(missing_condition="w.x IS NULL", source="x", missing_semantics="unknown")
WAY_DEFINITE = WayMaterialCoverageSpec(missing_condition="w.y IS NULL", source="y", missing_semantics="definite")
EDGE_UNKNOWN = EdgeMaterialCoverageSpec(present_condition="em.z IS NOT NULL", source="z", missing_semantics="unknown")
EXCLUDED = CoverageExcluded(reason="都度引く", missing_semantics="unknown")


def spec(material_id: str, dtype="numeric", coverage=WAY_UNKNOWN, **fields) -> MaterialSpec:
    """欠損の見方が不明な材料（網羅の集計の対象）。"""
    return material(material_id, dtype, coverage=coverage, **fields)


@pytest.fixture
def catalog(monkeypatch):
    """数値・真偽（欠損が不明／確定）・分類の材料と、SQLで求められない材料・タイルに載る材料の組。"""
    specs = [
        spec("num_b", tile_property="num_b_tile", primary_attribute=ATTR_A),
        spec("num_a", coverage=EDGE_UNKNOWN),
        spec("bool_definite", "boolean", WAY_DEFINITE, tile_property="bool_tile", primary_attribute=ATTR_A),
        spec("bool_unknown", "boolean", WAY_UNKNOWN),
        spec("cat_a", "categorical", WAY_DEFINITE, tile_property="cat_tile", primary_attribute=ATTR_B),
        spec("class_a", source="road_class", value_sql=None, coverage=EXCLUDED),
        spec("per_year_a", coverage=EXCLUDED),
    ]
    replace_material_catalog(monkeypatch, specs)


@pytest.mark.parametrize(
    "fields",
    [
        {"value_labels": {"a": "あ"}},  # 対訳は分類の値にだけ付く
        {"value_sql": None},  # DBが値を求めない静的材料は、全区間で値が欠ける
        {"source": "road_class", "value_sql": "w.x", "coverage": EXCLUDED},  # DBの列にも載り、区分の値と2つの出どころを持つ
        {"source": "road_class", "value_sql": None},  # DBに無い値の欠損率を数える
        # 地図の表示の軸は材料を一次属性の宣言そのもので照らすので、同じ`attr_id`の写しは表に無いものとして断る。
        {"primary_attribute": ATTR_A.model_copy()},
    ],
)
def test_a_declaration_that_does_not_fit_its_dtype_or_source_is_refused(fields):
    with pytest.raises(ValidationError):
        spec("x", **fields)


def test_the_matrix_columns_are_the_materials_with_sql_sorted_by_id(catalog):
    numeric, categorical = material_catalog.material_array_columns()

    # 真偽の材料も、タグの不在の意味によらず数値の行列に載る（欠損をNaNで持てる）。
    assert numeric == ("bool_definite", "bool_unknown", "num_a", "num_b", "per_year_a")
    assert categorical == ("cat_a",)


def test_every_material_is_either_measured_for_coverage_or_excluded_with_a_reason(catalog):
    measured = material_catalog.material_coverage_specs()
    excluded = material_catalog.material_coverage_exclusions()

    assert measured["num_a"] == EDGE_UNKNOWN
    assert excluded == {"class_a": "都度引く", "per_year_a": "都度引く"}


@pytest.mark.parametrize(
    ("attribute", "tile_property", "semantics"),
    [
        (ATTR_A, "num_b_tile", "unknown"),
        (ATTR_A, "bool_tile", "definite"),
        (ATTR_B, "num_b_tile", None),  # 別の属性の材料
        (ATTR_A, "nothing", None),
    ],
)
def test_a_display_axis_takes_the_missing_semantics_of_the_material_on_its_tile_property(
        catalog, attribute, tile_property, semantics):
    assert material_catalog.display_axis_missing_semantics(attribute, tile_property) == semantics


@pytest.mark.parametrize(
    ("catalog_", "refused"),
    [
        pytest.param({"num_a": spec("num_b")}, True, id="鍵と材料のidが食い違う"),
        pytest.param(
            {"num_a": spec("num_a", tile_property="t"), "num_b": spec("num_b", tile_property="t")},
            True,
            id="同じタイルの列に2つの材料",
        ),
        pytest.param(
            {"num_a": spec("num_a", tile_property="t"), "num_b": spec("num_b", tile_property="u")},
            False,
            id="材料ごとに1つの列",
        ),
    ],
)
def test_a_catalog_handing_out_a_material_two_ways_is_refused(catalog_, refused):
    with pytest.raises(ValueError) if refused else nullcontext():
        material_catalog.check_material_catalog(catalog_)
