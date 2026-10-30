"""評価軸の定義（`domain/axis_definitions.py: AxisDefinition`）を材料の値へ通し、要素ごとの得点・生値を求める。

評価は`evaluate_axis`1本で、Pythonの値で持つ入口（`evaluate_axes_values`等）も配列にして通す。
欠損値の表現はPythonの値で持つ入口がNone、配列がNaN。
"""

import math
from collections import ChainMap
from collections.abc import Collection, Iterable, MutableMapping
from typing import Mapping, NamedTuple, Sequence, SupportsFloat, cast

import numpy as np

from app.domain.attributes import CategoricalColumn, MaterialColumn
from app.domain.axis_definitions import (
    AXIS_DEFINITIONS,
    AxisDefinition,
    AxisShape,
    BreakpointLinearShape,
    flag_or_value_name,
    published_axis_order,
    topological_axis_order,
)
from app.domain.axis_templates import evaluate_categorical


def priority_override_mask(values: MaterialColumn, equals: str) -> np.ndarray:
    """0次条件が材料の値のどの要素に当たるか。**一致の判定はここだけが持つ**。

    `equals`は`CategoricalShape.mapping`のキーと同じ読み方をする（"true"/"false"だけを真偽へ読み、
    それ以外は書いたとおりの値の名前）。真偽の材料は1.0/0.0/NaNの数値の配列で届き
    （`material_catalog.material_array_columns`）、真偽との`==`が1.0/0.0と一致する。分類の材料はルート選びでは`CategoricalColumn`で届き、
    語彙の値と比べる。欠損（None・NaN）はどの`equals`にも当たらない。
    """
    if isinstance(values, CategoricalColumn):
        return values.equals(flag_or_value_name(equals))
    return np.asarray(values == flag_or_value_name(equals), dtype=bool)


def _numeric_column(values: Sequence[object]) -> np.ndarray:
    """項の材料の値の並び（欠損=None）を数値の配列へ（真偽は1.0/0.0、欠損はNaN）。項の材料は
    numeric/booleanに限られる（`domain/axis_definitions.py: check_axis_definition`）。"""
    return np.array([np.nan if v is None else float(cast(SupportsFloat, v)) for v in values], dtype=float)


def _value_column(values: Sequence[object]) -> np.ndarray:
    """項以外で読む材料（分類の材料・0次条件の材料）の値の並びを、値のままのobjectの配列へ
    （欠損はNone）。文字列を固定長の文字列の配列にすると、対応表の長いキーが切り詰められる。"""
    column = np.empty(len(values), dtype=object)
    column[:] = list(values)
    return column


def _python_value_columns(
    materials: Mapping[str, Sequence[object]], material_ids: Iterable[str], numeric_ids: Collection[str], length: int
) -> dict[str, np.ndarray]:
    """Pythonの値の並び（欠損=None）を、`evaluate_axis`が材料の型ごとに受け取る形の配列へ
    並べ替える。`materials`に無い材料は全要素欠損。"""
    missing: Sequence[object] = [None] * length
    return {
        material_id: (_numeric_column if material_id in numeric_ids else _value_column)(
            materials.get(material_id, missing)
        )
        for material_id in material_ids
    }


def _term_material_ids(definitions: Iterable[AxisDefinition]) -> set[str]:
    return {
        term.material
        for definition in definitions
        if isinstance(definition.shape, BreakpointLinearShape)
        for term in definition.shape.terms
    }


def _scores_or_none(scores: np.ndarray) -> list[float | None]:
    return [None if math.isnan(score) else score for score in scores.tolist()]


def evaluate_axes_values(materials: Mapping[str, Sequence[object]], length: int) -> dict[str, list[float | None]]:
    """材料id→Pythonの値の並び（長さ`length`、欠損=None）から、公開軸ごとの要素の得点を求める
    （評価できない要素はNone）。評価は配列へ並べ替えて`evaluate_axes_array`が行う。
    公開軸だけを依存順（`published_axis_order`）に返す。

    評価できなかった公開軸も、キーを残して値をNoneにする。
    """
    evaluated = evaluate_axes_array(_axes_python_value_columns(materials, length), AXIS_DEFINITIONS)
    return {axis_id: _scores_or_none(evaluated[axis_id]) for axis_id in published_axis_order(AXIS_DEFINITIONS)}


def evaluate_axes_inputs(materials: Mapping[str, Sequence[object]], length: int) -> dict[str, list[object]]:
    """公開軸ごとの、得点へ写す前の値（欠損=None）。折れ点の軸は生値、対応表の軸は引く材料の値。
    形の入力は`evaluate_axes_values`と同じ。

    この値が同じ道は、折れ点・対応表をどう置いても同じ得点になる（0次条件が当たる道を除く）。
    """
    columns = _axes_python_value_columns(materials, length)
    published = published_axis_order(AXIS_DEFINITIONS)
    evaluations = evaluate_axes(columns, AXIS_DEFINITIONS, raw_axis_ids=published)
    with_axes: dict[str, MaterialColumn] = {**columns, **{a: e.score for a, e in evaluations.items()}}
    inputs: dict[str, list[object]] = {}
    for axis_id in published:
        shape = AXIS_DEFINITIONS[axis_id].shape
        if isinstance(shape, BreakpointLinearShape):
            raw = evaluations[axis_id].raw
            assert raw is not None  # 公開軸は生値も求めて評価している（`raw_axis_ids`）
            inputs[axis_id] = list(_scores_or_none(raw))
        else:
            column = with_axes[shape.material]
            assert isinstance(column, np.ndarray)  # Pythonの値の入口は分類の番号の列を作らない
            inputs[axis_id] = [None if isinstance(v, float) and math.isnan(v) else v for v in column.tolist()]
    return inputs


def _axes_python_value_columns(materials: Mapping[str, Sequence[object]], length: int) -> dict[str, np.ndarray]:
    """全軸が読む葉の材料（他の軸を除く）を、`evaluate_axes_array`が受け取る形の配列へ並べ替える。"""
    definitions = AXIS_DEFINITIONS.values()
    leaf_ids = {
        material_id
        for definition in definitions
        for material_id in definition.materials
        if material_id not in AXIS_DEFINITIONS
    }
    return _python_value_columns(materials, leaf_ids, _term_material_ids(definitions), length)


def evaluate_axes_array(
    materials: Mapping[str, MaterialColumn], definitions: dict[str, AxisDefinition]
) -> dict[str, np.ndarray]:
    """`definitions`の全軸の得点（軸id→得点）。評価は`evaluate_axes`。"""
    return {axis_id: evaluated.score for axis_id, evaluated in evaluate_axes(materials, definitions).items()}


def evaluate_axes(
    materials: Mapping[str, MaterialColumn],
    definitions: dict[str, AxisDefinition],
    raw_axis_ids: Collection[str] = (),
) -> dict[str, "AxisEvaluation"]:
    """`definitions`の全軸を依存順（内部軸→公開軸）で評価し、軸id→評価の辞書を返す。
    評価した軸の得点は、後の軸の材料として読まれる（他の軸を材料にする軸）。生値（`AxisEvaluation.raw`）は
    `raw_axis_ids`の軸だけが持つ——項の和は区間数ぶんの配列なので、要らない軸の分を握ったままにしない。
    """
    # 評価した軸の得点を材料の上に重ねる（材料の対応表を写さない。列を読まれたときに切り出す対応表も、読まない列を切り出さない）。
    # ChainMapは先頭の辞書にだけ書くので、材料の対応表は書き換えない。
    with_axes: ChainMap[str, MaterialColumn] = ChainMap({}, cast(MutableMapping[str, MaterialColumn], materials))
    evaluations: dict[str, AxisEvaluation] = {}
    for axis_id in topological_axis_order(definitions):
        evaluations[axis_id] = evaluate_axis(definitions[axis_id], with_axes, keep_raw=axis_id in raw_axis_ids)
        with_axes[axis_id] = evaluations[axis_id].score
    return evaluations


def _term_values(materials: Mapping[str, MaterialColumn], material_id: str) -> np.ndarray:
    """項の材料の配列。項の材料はnumeric/booleanに限られ（`domain/axis_definitions.py: check_axis_definition`）、分類の材料の列は来ない。"""
    values = materials[material_id]
    if isinstance(values, CategoricalColumn):
        raise TypeError(f"項の材料{material_id}が分類の材料です（項は数値・真偽の材料だけを読む）")
    return values


def _breakpoint_raw_total_array(
    shape: BreakpointLinearShape, materials: Mapping[str, MaterialColumn]
) -> tuple[np.ndarray, np.ndarray]:
    """`terms`の重み付き和（`preprocess`まで適用）と、全termの材料が欠損している要素の
    マスクを返す。折れ点を通す前の値で、得点（`evaluate_axis`）と生値（`raw_values`等）が共有する。"""
    total: np.ndarray | None = None
    all_missing: np.ndarray | None = None
    for term in shape.terms:
        values = _term_values(materials, term.material)
        # 項の材料は数値・真偽とも数値の配列で届き、NaNが欠損を表す。
        missing = np.isnan(values)
        all_missing = missing if all_missing is None else all_missing & missing
        if not term.required:
            values = np.where(missing, 0.0, values)
        contribution = values * term.weight
        total = contribution if total is None else total + contribution
    assert total is not None  # 定義上termsは1件以上
    assert all_missing is not None
    if shape.preprocess == "abs":
        total = np.abs(total)
    return total, all_missing


def _raw_value_of_total(total: np.ndarray, all_missing: np.ndarray) -> np.ndarray:
    """項の和を生値（全項の材料が欠損の要素はNaN）にする。"""
    return np.where(all_missing, np.nan, total)


def raw_values(shape: AxisShape, materials: Mapping[str, Sequence[object]], length: int) -> list[float | None]:
    """折れ点を通す前の生値（`AxisEvaluation.raw`）をPythonの値の並び（`evaluate_axes_values`と同じ形）から求める。
    保存前の`shape`も渡せるよう軸の定義ではなく形を受け取る。`CategoricalShape`は全要素None。"""
    if not isinstance(shape, BreakpointLinearShape):
        return [None] * length
    term_ids = [term.material for term in shape.terms]
    columns = _python_value_columns(materials, term_ids, term_ids, length)
    return _scores_or_none(_raw_value_of_total(*_breakpoint_raw_total_array(shape, columns)))


class AxisEvaluation(NamedTuple):
    """軸1本の評価（`evaluate_axis`）。"""

    score: np.ndarray
    # 折れ点を通す前の生値（欠損=NaN）。`evaluate_axis`の`keep_raw`を立てた折れ線の軸だけが持ち、ほかはNone。
    # 得点（0〜100）は目盛りの引き方に依存する相対評価のため、軸単体では経路の良し悪しを判断できない。生値を
    # その単位とともに添えると、他の軸を見ずに判断できる。
    raw: np.ndarray | None


def evaluate_axis(
    definition: AxisDefinition, materials: Mapping[str, MaterialColumn], *, keep_raw: bool = False
) -> AxisEvaluation:
    """材料の配列から要素ごとの軸の得点を求める（欠損=NaN）。軸の評価はこれ1本で、折れ線の軸は項の和を
    1回だけ求めて得点と、`keep_raw`なら生値（`AxisEvaluation.raw`）に使う。

    `materials`は材料id→同じ長さの列（数値・真偽の材料はfloat配列で、真偽は1.0/0.0、
    欠損はNaN。categorical材料はルート選びでは`CategoricalColumn`、Pythonの値の入口では
    dtype=object の配列で欠損はNone）。requiredな材料のNaNは演算で
    自然に伝播し、required=Falseの材料のNaNは0へ置き換えて寄与なしとして扱う。ただし全termの
    材料が欠損している要素はNaN（評価不能）を返す——寄与が1件も無い状態へ「NaNは0とみなす」
    規則を適用すると「材料が1つも観測されていない」ことと「観測した結果が0だった」ことが
    区別できないため。

    `definition.priority_overrides`はshape計算の結果へ後から重ねる
    （`np.where`をpriority_overridesの逆順に重ねることで、定義順で最初に一致した条件が
    最優先になる）。
    """
    shape = definition.shape
    raw: np.ndarray | None = None
    if isinstance(shape, BreakpointLinearShape):
        term_total = _breakpoint_raw_total_array(shape, materials)
        result = shape.score_array(*term_total)
        if keep_raw:
            raw = _raw_value_of_total(*term_total)
    else:
        # CategoricalShape。真偽の材料の1.0/0.0の数値配列は真偽のキーとの一致が同じ答えになるため、
        # キーをfloatへ変えない。
        result = evaluate_categorical(materials[shape.material], shape.mapping)
    for override in reversed(definition.priority_overrides):
        mask = priority_override_mask(materials[override.material], override.equals)
        result = np.where(mask, override.value, result)
    return AxisEvaluation(result, raw)
