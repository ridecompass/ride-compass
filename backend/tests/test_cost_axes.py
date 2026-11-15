"""`domain/cost_axes.py`——費用の軸（費目と1対1）の定義の形と、管理APIが受ける前の検証。

入口は`CostAxisDefinitions`（型の検証）と`check_cost_axes`（材料と区分に照らす検証）と`surplus_class_weights`（分け方に無い区分の重さ）。

ここで見ないもの:
- 軸の定義を保存して読み書きする管理API → `test_cost_axis_admin_routes.py`
- 軸の倍率と帳簿から費用を組むこと → `test_ledger_costs.py`
"""

import pytest
from pydantic import ValidationError

from app.domain.cost_axes import EFFORT_AXES, CostAxisDefinitions, check_cost_axes, surplus_class_weights
from app.domain.material_catalog import GRADIENT_PERCENT
from tests.road_class_fixture import classification, road_classes

SURFACE = road_classes({"surface_estimate": classification({"paved": [], "gravel": [], "unknown_track": []})})
LENS = {"thresholds": [1.0, 5.0], "band_labels": ["少ない", "中くらい", "多い"]}


def _axis(label: str, **burden) -> dict:
    return {"label": label, "description": "", "icon_id": "icon", "lens": LENS, **({"burden": burden} if burden else {})}


def _definitions(**burden_axes) -> dict:
    return {"effort": {axis_id: _axis(axis_id) for axis_id in EFFORT_AXES}, "burden": burden_axes,
            "total_lens": _axis("総合")}


VIBRATION = _axis("振動", kind="categorical", material="class:surface_estimate",
                  per_km={"paved": 0.0, "gravel": 0.6, "unknown_track": 0.5})


def test_a_definition_with_every_effort_axis_and_a_burden_axis_over_every_class_passes():
    definitions = CostAxisDefinitions.model_validate(_definitions(vibration=VIBRATION))

    assert check_cost_axes(definitions, SURFACE) == []


@pytest.mark.parametrize(
    "definition",
    [
        {"effort": {axis_id: _axis(axis_id) for axis_id in list(EFFORT_AXES)[1:]}, "burden": {}, "total_lens": _axis("総合")},
        _definitions(**{next(iter(EFFORT_AXES)): VIBRATION}),
        _definitions(vibration={**VIBRATION, "burden": {**VIBRATION["burden"], "per_km": {"paved": -0.1}}}),
        _definitions(vibration={**VIBRATION, "lens": {"thresholds": [5.0, 1.0], "band_labels": ["a", "b", "c"]}}),
        _definitions(vibration=_axis("勾配", kind="linear", material=GRADIENT_PERCENT, points=[[5.0, 1.0], [1.0, 0.0]])),
    ],
    ids=["体力の軸が欠ける", "道のストレスの軸が体力の軸のidを使う", "負の重さ", "レンズの境目が昇順でない", "折れ線の値が昇順でない"],
)
def test_a_definition_the_form_does_not_allow_is_refused(definition):
    """体力の軸はコードの表と同じ一覧で、道のストレスの軸はそれと重ならない（同じ費目を2つの軸が持つと同じ損を2回数える）。
    重さは0以上（費用が所要時間を下回ると、探索の見込みが成り立たない）。"""
    with pytest.raises(ValidationError):
        CostAxisDefinitions.model_validate(definition)


@pytest.mark.parametrize(
    ("burden", "problem"),
    [
        ({"per_km": {"paved": 0.0, "gravel": 0.6}}, "重さの無い区分 ['unknown_track']"),
        ({"material": "class:no_such"}, "知らない分け方の材料"),
        ({"material": "no_such"}, "知らない材料"),
        ({"material": "lit"}, "区分の重さは区分の材料"),
    ],
    ids=["区分の漏れ", "知らない分け方", "知らない材料", "区分でない材料に区分の重さ"],
)
def test_a_burden_that_does_not_fit_its_material_is_reported(burden, problem):
    """区分の重さは分け方のすべての区分に書く——書いていない区分を0や平均とみなすと、区分を足したときに黙ってその道のストレスが
    消える。"""
    definitions = CostAxisDefinitions.model_validate(
        _definitions(vibration={**VIBRATION, "burden": {**VIBRATION["burden"], **burden}}))

    assert any(problem in found for found in check_cost_axes(definitions, SURFACE))


@pytest.mark.parametrize(
    ("per_km", "surplus"),
    [
        ({"paved": 0.0, "gravel": 0.6, "unknown_track": 0.5}, []),
        ({"paved": 0.0, "gravel": 0.6, "unknown_track": 0.5, "sand": 1.0}, ["vibration: 分け方に無い区分の重さ ['sand']"]),
    ],
    ids=["余りなし", "余りあり"],
)
def test_a_weight_for_a_class_the_classification_does_not_have_is_surplus_not_a_problem(per_km, surplus):
    """分け方に無い区分の重さは費用に効かないので断らない——断ると、区分を足す前に重さを書く順も、区分を消したあとに重さを消す
    順も通らない。打ち間違いの知らせのために、余りとして挙げる。"""
    definitions = CostAxisDefinitions.model_validate(
        _definitions(vibration={**VIBRATION, "burden": {**VIBRATION["burden"], "per_km": per_km}}))

    assert check_cost_axes(definitions, SURFACE) == []
    assert surplus_class_weights(definitions, SURFACE) == surplus


def test_a_curve_over_a_material_that_is_not_a_number_is_reported():
    definitions = CostAxisDefinitions.model_validate(
        _definitions(lighting=_axis("照明", kind="linear", material="lit", points=[[0.0, 1.0]])))

    assert check_cost_axes(definitions, SURFACE) == ["lighting: 折れ線は数値の材料にだけ書ける: lit（boolean）"]

