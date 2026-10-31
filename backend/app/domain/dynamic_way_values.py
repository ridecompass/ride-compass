"""ルートを出す前の地図が塗る軸の値の、要求の条件の組み立てと、フィーチャーの材料から地図が塗る値への写し。

状態機械（ルート未確定=利用者が決めた条件を全道路へ一律適用／ルート確定後=ルート自身の実値をルート線のみへ
適用）は軸非依存で、要求の条件（時刻・向き・速度）のうち何が要るかは、軸の葉の材料の値を配るサービスが受け取る
条件の型で決まる（`assemble_conditions`）。

**この層で扱うidは軸id（`axis_definitions.axis_id`）であり、材料id（`material_catalog.py`のキー、例:
`wind_drag_ratio`）ではない。**両者は名前空間が異なる別概念で、軸は葉まで辿った材料で配信のサービスと結ばれる
（`services/dedicated_way_values.py: DEDICATED_WAY_VALUE_SERVICES`）。
"""

from collections.abc import Mapping, Sequence
from dataclasses import MISSING, dataclass, fields
from datetime import datetime
from typing import TYPE_CHECKING, Literal, TypeVar, cast

import numpy as np

from app.domain.attributes import CategoricalColumn, MaterialColumn
from app.domain.axis_definitions import AxisDefinition, BreakpointLinearShape, averages_density, axis_dependencies
from app.domain.axis_evaluation import evaluate_axes_array, priority_override_mask
from app.domain.difficulty import round_difficulty, weighted_mean_by_distance
from app.domain.evaluation import empty_material_arrays
from app.domain.gradient import travel_direction_formula
from app.domain.map_paint import SignedMaterialMapValue, map_paint
from app.domain.material_catalog import all_material_specs, segment_material_ids
from app.domain.search_graph import EDGE_VALUE_DTYPE
from app.domain.way_value_formula import (
    FALSE,
    Condition,
    FeatureValue,
    FormulaNode,
    Interpolate,
    Missing,
    Round,
    Unary,
    WayValueFormula,
    add,
    all_of,
    any_of,
    case,
    const,
    evaluate_formula,
    feature,
    mul,
    way_values_from_formula,
)

if TYPE_CHECKING:
    from _typeshed import DataclassInstance

#: 地図の配信の要求が運ぶ条件の名前。`WayValueQuery`の欄の名前で、配信のクエリパラメータの名前でもある。
WayValueConditionName = Literal["at", "bearing_deg", "speed_kmh"]


@dataclass(frozen=True)
class WayValueQuery:
    """地図の配信の要求が運ぶ条件。どれも省略されうる——どれが要るかは、値を返すサービスが
    受け取る条件の型（`assemble_conditions`の`kind`）が決める。欄の名前は`WayValueConditionName`。"""

    at: datetime | None
    bearing_deg: float | None
    speed_kmh: float | None


@dataclass(frozen=True)
class MissingConditions:
    """サービスが要る条件のうち、要求に無かったものの名前（`WayValueQuery`の欄の名前）。"""

    names: tuple[str, ...]


_C = TypeVar("_C", bound="DataclassInstance")


def assemble_conditions(kind: type[_C], query: WayValueQuery) -> _C | MissingConditions:
    """サービスが受け取る条件（frozen dataclassの`kind`）を要求から組み立てる。

    `kind`の欄は`WayValueQuery`の同じ名前の欄から取り、既定値の無い欄が要るものになる。
    **方位・速度の欠けを判定するのはここだけ**——サービスは組み立て済みの値だけを受け取るので、
    要る欄は`None`を許さない型のまま届く。地図の配信は欠けを422に、区間インスペクタは
    「データなし」にする。
    """
    kind_fields = fields(kind)
    values = {field.name: getattr(query, field.name) for field in kind_fields}
    missing = tuple(
        field.name for field in kind_fields
        if values[field.name] is None and field.default is MISSING and field.default_factory is MISSING
    )
    if missing:
        return MissingConditions(missing)
    return kind(**values)


@dataclass(frozen=True)
class FeatureMaterials:
    """タイル1枚のフィーチャーごとの材料。`columns`の各列は`feature_keys`と同じ並びで、評価（`evaluate_axes_array`）へ
    そのまま渡せる形（数値・真偽はfloatの配列で欠損はNaN、分類は`CategoricalColumn`）。"""

    feature_keys: tuple[str, ...]
    columns: dict[str, MaterialColumn]

    def __len__(self) -> int:
        return len(self.feature_keys)

    def of_feature(self, feature_key: str) -> "FeatureMaterials":
        """`feature_key`のフィーチャーの行だけのもの（タイルに無ければ0行）。"""
        rows = _rows_of(self.feature_keys, feature_key)
        return FeatureMaterials(
            feature_keys=(feature_key,) * len(rows),
            columns={material_id: _take(column, rows) for material_id, column in self.columns.items()},
        )


@dataclass(frozen=True)
class FeatureSegments:
    """道1本を1つのフィーチャーにするタイルの、フィーチャーごとの区間（`road_edges`の行）と、区間ごとに値が違いうる材料
    （`domain/material_catalog.py: segment_material_ids`）の区間の値。並びは区間ごとで、どの列も同じ並び。"""

    #: 区間が属するフィーチャーの鍵（`FeatureMaterials.feature_keys`と同じ鍵）。
    feature_keys: tuple[str, ...]
    distance_m: np.ndarray
    #: 区間が属するフィーチャー（道）の両端を結ぶ方位（度）。向きに依る材料を、道1本と同じ向きで読むのに使う。
    feature_bearing_deg: np.ndarray
    columns: dict[str, MaterialColumn]

    def __len__(self) -> int:
        return len(self.feature_keys)

    def of_feature(self, feature_key: str) -> "FeatureSegments":
        """`feature_key`のフィーチャーの区間だけのもの（タイルに無ければ0行）。"""
        rows = _rows_of(self.feature_keys, feature_key)
        return FeatureSegments(
            feature_keys=(feature_key,) * len(rows),
            distance_m=np.asarray(self.distance_m)[rows],
            feature_bearing_deg=np.asarray(self.feature_bearing_deg)[rows],
            columns={material_id: _take(column, rows) for material_id, column in self.columns.items()},
        )


def _rows_of(feature_keys: Sequence[str], feature_key: str) -> np.ndarray:
    return np.array([row for row, key in enumerate(feature_keys) if key == feature_key], dtype=np.int64)


def axis_with_dependencies(axis_id: str, definitions: Mapping[str, AxisDefinition]) -> dict[str, AxisDefinition]:
    """`axis_id`の軸と、それが材料として読む軸を内部軸まで辿ったもの。並びは`definitions`の並び。"""
    known = set(definitions)
    found: set[str] = set()
    pending = [axis_id]
    while pending:
        current = pending.pop()
        if current not in found:
            found.add(current)
            pending.extend(axis_dependencies(definitions[current], known))
    return {key: definition for key, definition in definitions.items() if key in found}


def leaf_materials(definitions: Mapping[str, AxisDefinition]) -> set[str]:
    """`definitions`の軸が読む材料のうち、`definitions`の軸でないもの（葉の材料）。"""
    return {material for definition in definitions.values() for material in definition.materials
            if material not in definitions}


def _feature_columns(
    feature_keys: Sequence[str],
    materials: Mapping[str, MaterialColumn],
    served: Mapping[str, Mapping[str, float | None]],
) -> tuple[dict[str, MaterialColumn], np.ndarray]:
    """`materials`へ`served`の材料の列を重ねた列と、配信が値をNoneで返した（走行方位で決まらない）フィーチャーの印。"""
    n = len(feature_keys)
    columns: dict[str, MaterialColumn] = dict(materials)
    undetermined = np.zeros(n, dtype=bool)
    for material_id, values in served.items():
        column = np.full(n, np.nan)
        for row, key in enumerate(feature_keys):
            if key not in values:
                continue
            value = values[key]
            if value is None:
                undetermined[row] = True
            else:
                column[row] = value
        columns[material_id] = column
    columns.update(empty_material_arrays(n, (spec.material_id for spec in all_material_specs()), columns))
    return columns, undetermined


def _searched_scores(scores: np.ndarray) -> np.ndarray:
    """区間の得点を、探索の静的スコア行列が持つ桁（`EDGE_VALUE_DTYPE`）へ丸めて float64 で返す。区間から畳む値は
    ルートの値と同じく0.1刻みへ丸めるので、float64 のまま畳むと、丸めの境で地図の色とその道を走ったルートの値が1段
    ずれる。道1本の材料で評価する得点（`paint_feature_values`）は丸めない——地図へ配る木（`axis_way_value_formula`）は
    float64 で評価され、そちらと合わせる。"""
    return np.asarray(scores, dtype=EDGE_VALUE_DTYPE).astype(float)


def _signed_material(axis_id: str, definitions: Mapping[str, AxisDefinition], *, as_difficulty: bool) -> str | None:
    """地図が軸`axis_id`について得点ではなく符号付き材料の値を塗るなら、その材料。"""
    paint = map_paint(definitions[axis_id]).value
    return paint.material if isinstance(paint, SignedMaterialMapValue) and not as_difficulty else None


def paint_feature_values(
    axis_id: str,
    definitions: Mapping[str, AxisDefinition],
    feature_keys: Sequence[str],
    materials: Mapping[str, MaterialColumn],
    served: Mapping[str, Mapping[str, float | None]],
    *,
    as_difficulty: bool,
) -> dict[str, float | None]:
    """フィーチャーごとに、地図が軸`axis_id`について塗る値（`map_paint`の塗る値が難易度なら得点、符号付き材料なら
    その材料の値）。`as_difficulty`なら、符号付き材料を塗る軸も得点を返す（区間インスペクタ）。

    `materials`は`feature_keys`と同じ並びの材料の列、`served`は配信のサービスが返した材料ごとの`{フィーチャーの鍵: 値}`で、
    同じ材料の列を置き換える（鍵の無いフィーチャーは欠損）。得点は探索の静的スコア行列と同じ評価
    （`evaluate_axes_array`）を、軸とそれが読む軸だけへ通して求める。どちらにも無い材料は値の無い列になる。

    評価できないフィーチャーは結果から除く（地図上は「データなし」）。配信が値をNoneで返したフィーチャー（走行方位で
    決まらない）は、Noneのまま返す（地図上は「向きで決まらない」）。
    """
    columns, undetermined = _feature_columns(feature_keys, materials, served)
    signed_material = _signed_material(axis_id, definitions, as_difficulty=as_difficulty)
    if signed_material is not None:
        painted = np.asarray(columns[signed_material], dtype=float)
    else:
        painted = evaluate_axes_array(columns, axis_with_dependencies(axis_id, definitions))[axis_id]
    out: dict[str, float | None] = {}
    for row, key in enumerate(feature_keys):
        if undetermined[row]:
            out[key] = None
        elif not np.isnan(painted[row]):
            out[key] = float(painted[row])
    return out


def folds_segments(axis_id: str, definitions: Mapping[str, AxisDefinition]) -> bool:
    """道1本のフィーチャーの値を、その道の区間ごとに評価した得点から畳む軸か（`paint_folded_feature_values`）。

    ルートの値は区間の得点の距離平均で、区間ごとに値の違う材料を読む軸では、道1本の材料で評価した得点と違う。
    密度の軸（`averages_density`）は畳まない——ルートの値は横軸の値（1kmあたりの量）の距離平均の得点で、道1本の
    材料（道の数÷道の長さ）がその平均と同じ値になる。
    """
    if averages_density(definitions[axis_id]):
        return False
    return bool(leaf_materials(axis_with_dependencies(axis_id, definitions)) & segment_material_ids())


def _take(column: MaterialColumn, rows: np.ndarray) -> MaterialColumn:
    return column.take(rows) if isinstance(column, CategoricalColumn) else np.asarray(column)[rows]


def paint_folded_feature_values(
    axis_id: str,
    definitions: Mapping[str, AxisDefinition],
    feature_keys: Sequence[str],
    materials: Mapping[str, MaterialColumn],
    served: Mapping[str, Mapping[str, float | None]],
    segments: FeatureSegments,
    served_segments: Mapping[str, np.ndarray],
    *,
    as_difficulty: bool,
) -> dict[str, float | None]:
    """道1本のフィーチャーごとに地図が軸`axis_id`について塗る値を、その道の区間をルートの区間に見立てて、ルートの値と
    同じ決まり（`domain/route.py: merge_route_values`）で畳んで求める。

    区間の材料は、区間ごとに値が違いうる材料なら`segments`の区間の値（配信のサービスが配る材料は`served_segments`の
    区間の値）、ほかの材料は区間が属するフィーチャーの値（`paint_feature_values`と同じ`materials`・`served`）。
    区間から畳まない軸（`folds_segments`）と、区間の無いフィーチャーは、フィーチャーの値で評価する（`paint_feature_values`）。

    符号付き材料を塗る軸は、畳んだ得点を、その得点に当たる材料の値の大きさへ戻し（`smallest_magnitude_at`）、区間の
    材料の値の距離平均の符号（道全体で上るか下るか。平均が0なら正）を付ける——段はルートの値と揃い、地図は材料の
    目盛りと向きの塗り分けを保つ。`as_difficulty`なら、符号付き材料を塗る軸も畳んだ得点を返す。配信が値をNoneで返した
    フィーチャーは、Noneのまま返す。
    """
    whole = paint_feature_values(axis_id, definitions, feature_keys, materials, served, as_difficulty=as_difficulty)
    if not folds_segments(axis_id, definitions):
        return whole
    columns, undetermined = _feature_columns(feature_keys, materials, served)
    row_of = {key: row for row, key in enumerate(feature_keys)}
    owner = np.array([row_of.get(key, -1) for key in segments.feature_keys], dtype=np.int64)
    kept = owner >= 0
    owner = owner[kept]
    distance_km = np.asarray(segments.distance_m, dtype=float)[kept] / 1000
    segment_columns: dict[str, MaterialColumn] = {
        material_id: _take(column, owner) for material_id, column in columns.items()
    }
    segment_columns.update({material_id: _take(column, np.flatnonzero(kept))
                            for material_id, column in {**segments.columns, **served_segments}.items()})
    dependencies = axis_with_dependencies(axis_id, definitions)
    scores = _searched_scores(evaluate_axes_array(segment_columns, dependencies)[axis_id])

    by_feature: dict[int, list[int]] = {}
    for index, row in enumerate(owner.tolist()):
        by_feature.setdefault(row, []).append(index)
    signed_material = _signed_material(axis_id, definitions, as_difficulty=as_difficulty)
    signed = None if signed_material is None else np.asarray(segment_columns[signed_material], dtype=float)

    def distance_mean(values: np.ndarray, indexes: list[int]) -> float | None:
        return weighted_mean_by_distance(
            [(None if np.isnan(values[i]) else float(values[i]), float(distance_km[i])) for i in indexes])

    out: dict[str, float | None] = {}
    for row, key in enumerate(feature_keys):
        indexes = by_feature.get(row)
        if undetermined[row]:
            out[key] = None
            continue
        if indexes is None:
            if key in whole:
                out[key] = whole[key]
            continue
        mean = distance_mean(scores, indexes)
        if mean is None:
            continue
        score = round_difficulty(mean)
        if signed is None:
            out[key] = score
            continue
        direction = distance_mean(signed, indexes)
        # `signed_material`は折れ線の軸にしか付かない。
        magnitude = cast(BreakpointLinearShape, definitions[axis_id].shape).smallest_magnitude_at(score)
        out[key] = -magnitude if direction is not None and direction < 0 else magnitude
    return out


@dataclass(frozen=True)
class ServedMaterialFormula:
    """配信のサービスが配る材料の値を、サービスが配る道ごとの材料（葉）と要求の条件から求める木。"""

    formula: WayValueFormula
    #: 値が道を道の向き寄りに辿るか逆向き寄りに辿るかだけで決まる材料の、(順向き, 逆向き)の値の木（条件を読まない）。
    #: このとき`formula`は2つを`domain/gradient.py: travel_direction_formula`で選ぶ木（`by_direction_material`）。
    by_direction: tuple[FormulaNode, FormulaNode] | None = None
    #: 道ごとの材料（葉）を地図へ配らないか。葉を道ごとに読める形で外へ出せない材料（気象の予報の値そのもの等）は、
    #: 地図の要求の条件で値まで求めてから配る（`map_way_value_formula`）。
    withholds_leaves: bool = False


def by_direction_material(forward: FormulaNode, backward: FormulaNode) -> ServedMaterialFormula:
    """道を辿る向きだけで値の決まる材料。"""
    return ServedMaterialFormula(travel_direction_formula(forward, backward), (forward, backward))


@dataclass(frozen=True)
class TileWayInputs:
    """タイル1枚で、軸の値を求めるのに読むもの。`materials`と`leaves`の各列は`feature_keys`と同じ並び。"""

    feature_keys: Sequence[str]
    #: タイルの材料（配信のサービスの材料だけを読む軸では空）。
    materials: Mapping[str, MaterialColumn]
    #: 配信のサービスが配る道ごとの材料（葉。値が無ければNaN）。
    leaves: Mapping[str, np.ndarray]
    #: 道1本のフィーチャーの値を区間から畳むときの区間と、区間ごとの葉。畳まないときはNone。
    segments: FeatureSegments | None = None
    segment_leaves: Mapping[str, np.ndarray] | None = None


# 軸の木が読む、前もって求めた道ごとの材料の名前。`:`を含め、材料id・軸id・配信のサービスの葉と重ならない綴りにする。
_FIXED_LEAF = "axis:value"
_UNDETERMINED_LEAF = "axis:undetermined"
_FORWARD_LEAF = "axis:forward"
_BACKWARD_LEAF = "axis:backward"
_PRIORITY_LEAF_PREFIX = "axis:priority:"


def _dependent_materials(served: Mapping[str, ServedMaterialFormula]) -> list[str]:
    """値が要求の条件（走行方位・想定速度）で変わる材料。"""
    return sorted(
        material for material, served_formula in served.items()
        if served_formula.formula.names_read(Condition)
    )


def _reads_by_direction_only(served: Mapping[str, ServedMaterialFormula], dependent: Sequence[str]) -> bool:
    return all(served[material].by_direction is not None for material in dependent)


def axis_way_value_formula(
    axis_id: str, definitions: Mapping[str, AxisDefinition], served: Mapping[str, ServedMaterialFormula],
    *, as_difficulty: bool,
) -> WayValueFormula | None:
    """軸`axis_id`について地図が塗る値（`paint_feature_values`・`paint_folded_feature_values`と同じ値）を、道ごとの材料
    （`axis_way_materials`）と要求の条件から求める木。`served`は軸が読む配信の材料の木。

    木にするのは、値のうち要求の条件で変わる部分だけで、変わらない部分は道ごとの材料として前もって求める:
    - 条件で変わる材料を読まない軸は、値そのものが材料になる。
    - 条件で変わる材料がどれも道を辿る向きだけで決まる（`ServedMaterialFormula.by_direction`）軸は、順向き・逆向きに
      辿ったときの値が材料になり、木が向きで選ぶ。区間から畳む軸も、畳んだ値をこの形で配れる。
    - ほかは、軸の評価（`domain/axis_evaluation.py: evaluate_axis`）のうち条件で変わる材料に届く項を木へ開く。
      条件で変わらない材料・軸の得点と、0次条件の当たりは材料になる。

    木にできない軸はNone——区間から畳む軸（畳みは区間ごとの木が要る）と、条件で変わる材料に届く分類の形・0次条件の軸。
    """
    dependent = _dependent_materials(served)
    if not dependent:
        return WayValueFormula(value=feature(_FIXED_LEAF), undetermined=FALSE)
    if _reads_by_direction_only(served, dependent):
        return travel_direction_formula(feature(_FORWARD_LEAF), feature(_BACKWARD_LEAF))
    if folds_segments(axis_id, definitions):
        return None
    dependent_axes = {
        key for key in axis_with_dependencies(axis_id, definitions)
        if leaf_materials(axis_with_dependencies(key, definitions)) & set(dependent)
    }

    def material_node(material: str) -> FormulaNode | None:
        if material in dependent:
            return served[material].formula.value
        if material in dependent_axes:
            return score_node(material)
        return feature(material)

    def score_node(key: str) -> FormulaNode | None:
        definition = definitions[key]
        shape = definition.shape
        if not isinstance(shape, BreakpointLinearShape):
            return None
        total: FormulaNode | None = None
        missing: list[FormulaNode] = []
        for term in shape.terms:
            value = material_node(term.material)
            if value is None:
                return None
            is_missing = Unary(op="is_missing", arg=value)
            missing.append(is_missing)
            if not term.required:
                value = case(is_missing, const(0.0), value)
            contribution = mul(value, const(term.weight))
            total = contribution if total is None else add(total, contribution)
        assert total is not None  # 定義上termsは1件以上
        if shape.preprocess == "abs":
            total = Unary(op="abs", arg=total)
        node: FormulaNode = case(
            all_of(missing), Missing(), Round(arg=Interpolate(input=total, stops=shape.breakpoints), decimals=1))
        for index, override in reversed(list(enumerate(definition.priority_overrides))):
            if override.material in dependent or override.material in dependent_axes:
                return None
            node = case(feature(f"{_PRIORITY_LEAF_PREFIX}{key}:{index}"), const(override.value), node)
        return node

    signed_material = _signed_material(axis_id, definitions, as_difficulty=as_difficulty)
    value = material_node(signed_material) if signed_material is not None else score_node(axis_id)
    if value is None:
        return None
    return WayValueFormula(
        value=value, undetermined=any_of([served[material].formula.undetermined for material in dependent]))


def _served_values(
    served: Mapping[str, ServedMaterialFormula], inputs: TileWayInputs, conditions: Mapping[str, float],
    *, side: int | None = None,
) -> tuple[dict[str, dict[str, float | None]], dict[str, np.ndarray]]:
    """配信の材料ごとの`{フィーチャーの鍵: 値}`（値の決まらないフィーチャーはNone）と、区間ごとに値が違いうる材料の区間の
    値（決まらない区間はNaN）。`side`が0・1なら、向きだけで決まる材料は順向き・逆向きに辿ったときの値にする。"""
    values: dict[str, dict[str, float | None]] = {}
    segment_values: dict[str, np.ndarray] = {}
    for material, material_formula in served.items():
        if side is not None and material_formula.by_direction is not None:
            formula = WayValueFormula(value=material_formula.by_direction[side], undetermined=FALSE)
        else:
            formula = material_formula.formula
        values[material] = way_values_from_formula(formula, inputs.feature_keys, inputs.leaves, conditions)
        if inputs.segments is not None and material in segment_material_ids():
            leaves = inputs.segment_leaves or {}
            length = len(inputs.segments)
            undetermined = evaluate_formula(formula.undetermined, leaves, conditions, length)
            segment_values[material] = np.where(
                np.isnan(undetermined) | (undetermined == 0),
                evaluate_formula(formula.value, leaves, conditions, length), np.nan)
    return values, segment_values


def _paint(
    axis_id: str, definitions: Mapping[str, AxisDefinition], inputs: TileWayInputs,
    served: tuple[Mapping[str, Mapping[str, float | None]], Mapping[str, np.ndarray]], *, as_difficulty: bool,
) -> dict[str, float | None]:
    values, segment_values = served
    if inputs.segments is None:
        return paint_feature_values(
            axis_id, definitions, inputs.feature_keys, inputs.materials, values, as_difficulty=as_difficulty)
    return paint_folded_feature_values(
        axis_id, definitions, inputs.feature_keys, inputs.materials, values, inputs.segments, segment_values,
        as_difficulty=as_difficulty)


def _painted_column(feature_keys: Sequence[str], painted: Mapping[str, float | None]) -> np.ndarray:
    return np.array([np.nan if (value := painted.get(key)) is None else value for key in feature_keys], dtype=float)


def axis_way_materials(
    axis_id: str, definitions: Mapping[str, AxisDefinition], served: Mapping[str, ServedMaterialFormula],
    inputs: TileWayInputs, *, as_difficulty: bool,
) -> dict[str, np.ndarray]:
    """`axis_way_value_formula`の木が読む道ごとの材料（名前→`inputs.feature_keys`と同じ並びの値、無ければNaN）。
    木がNoneの軸には使わない。"""
    dependent = _dependent_materials(served)
    if not dependent:
        painted = _paint(axis_id, definitions, inputs, _served_values(served, inputs, {}), as_difficulty=as_difficulty)
        return {_FIXED_LEAF: _painted_column(inputs.feature_keys, painted)}
    service_leaves = {name for material in dependent for name in served[material].formula.names_read(FeatureValue)}
    out = {name: np.asarray(inputs.leaves[name], dtype=float) for name in service_leaves if name in inputs.leaves}
    if _reads_by_direction_only(served, dependent):
        for side, name in enumerate((_FORWARD_LEAF, _BACKWARD_LEAF)):
            painted = _paint(axis_id, definitions, inputs, _served_values(served, inputs, {}, side=side),
                             as_difficulty=as_difficulty)
            out[name] = _painted_column(inputs.feature_keys, painted)
        return out
    formula = axis_way_value_formula(axis_id, definitions, served, as_difficulty=as_difficulty)
    assert formula is not None
    fixed_served = {material: formula for material, formula in served.items() if material not in dependent}
    columns, _ = _feature_columns(inputs.feature_keys, inputs.materials, _served_values(fixed_served, inputs, {})[0])
    # 条件で変わる材料と、それに届く軸の得点は木が求める。ここでは欠けた列として置き、ほかの軸の得点だけを使う。
    columns.update({material: np.full(len(inputs.feature_keys), np.nan) for material in dependent})
    with_axes: dict[str, MaterialColumn] = {
        **columns, **evaluate_axes_array(columns, axis_with_dependencies(axis_id, definitions))}
    for name in formula.names_read(FeatureValue) - service_leaves:
        if name.startswith(_PRIORITY_LEAF_PREFIX):
            key, index = name.removeprefix(_PRIORITY_LEAF_PREFIX).rsplit(":", 1)
            override = definitions[key].priority_overrides[int(index)]
            out[name] = priority_override_mask(with_axes[override.material], override.equals).astype(float)
        else:
            out[name] = np.asarray(with_axes[name], dtype=float)
    return out


def _withholds_leaves(served: Mapping[str, ServedMaterialFormula]) -> bool:
    return any(served[material].withholds_leaves for material in _dependent_materials(served))


def map_way_value_formula(
    axis_id: str, definitions: Mapping[str, AxisDefinition], served: Mapping[str, ServedMaterialFormula],
) -> WayValueFormula | None:
    """地図へ配る、軸`axis_id`の値の木。地図はこの木を道ごとの材料（`map_way_materials`）と要求の条件で評価する。

    条件で変わる材料のどれかが葉を配らない（`ServedMaterialFormula.withholds_leaves`）軸は、値そのもの（と値の決まらない
    こと）を材料にする——材料は要求の条件で求めるので、条件が変わると材料を取り直す。ほかは`axis_way_value_formula`。
    """
    if not _withholds_leaves(served):
        return axis_way_value_formula(axis_id, definitions, served, as_difficulty=False)
    undetermined = any(served[material].formula.undetermined != FALSE for material in _dependent_materials(served))
    return WayValueFormula(
        value=feature(_FIXED_LEAF), undetermined=feature(_UNDETERMINED_LEAF) if undetermined else FALSE)


def map_way_materials(
    axis_id: str, definitions: Mapping[str, AxisDefinition], served: Mapping[str, ServedMaterialFormula],
    inputs: TileWayInputs, conditions: Mapping[str, float],
) -> dict[str, np.ndarray]:
    """`map_way_value_formula`の木が読む道ごとの材料（名前→`inputs.feature_keys`と同じ並びの値、無ければNaN）。
    `conditions`は、葉を配らない材料を読む軸でだけ読む。木がNoneの軸には使わない。"""
    if not _withholds_leaves(served):
        return axis_way_materials(axis_id, definitions, served, inputs, as_difficulty=False)
    painted = axis_way_values(axis_id, definitions, served, inputs, conditions, as_difficulty=False)
    return {
        _FIXED_LEAF: _painted_column(inputs.feature_keys, painted),
        _UNDETERMINED_LEAF: np.array(
            [1.0 if key in painted and painted[key] is None else np.nan for key in inputs.feature_keys], dtype=float),
    }


def axis_way_values(
    axis_id: str, definitions: Mapping[str, AxisDefinition], served: Mapping[str, ServedMaterialFormula],
    inputs: TileWayInputs, conditions: Mapping[str, float], *, as_difficulty: bool,
) -> dict[str, float | None]:
    """フィーチャーごとに、地図が軸`axis_id`について塗る値。木のある軸は、道ごとの材料（`axis_way_materials`）を木
    （`axis_way_value_formula`）で評価する——地図が同じ材料と木から求める値と揃う。木の無い軸は、配信の材料の値を
    条件で求めてから塗る（`paint_feature_values`・`paint_folded_feature_values`）。"""
    formula = axis_way_value_formula(axis_id, definitions, served, as_difficulty=as_difficulty)
    if formula is None:
        return _paint(
            axis_id, definitions, inputs, _served_values(served, inputs, conditions), as_difficulty=as_difficulty)
    leaves = axis_way_materials(axis_id, definitions, served, inputs, as_difficulty=as_difficulty)
    return way_values_from_formula(formula, inputs.feature_keys, leaves, conditions)
