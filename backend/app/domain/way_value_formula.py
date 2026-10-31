"""地図の道の値を、道ごとの材料と要求の条件から求める中立の式の木。

木は地図のライブラリに依らない演算だけで組み、backendはnumpyで評価する（`evaluate_formula`）。地図の側は同じ木を
自分の式へ置き換え、道ごとの材料（`FeatureValue`の名前）と条件（`Condition`の名前）を入れて同じ値を得る。
木の型はAPIの応答に載り、OpenAPIから画面の生成型へ流れる。

値の約束:
- 値の無い材料・欠けた値はNaN（JSONでは材料を載せない）。算術はNaNを伝え、比べはNaNを偽とする。
- 真偽は1.0/0.0の値で表し、真偽として読むときはNaNでも0でもない値を真とする（`Case`・`Binary`の論理・`Unary`の否定）。
- 剰余（`mod`）は割られる数の符号に従う（`np.fmod`）。
- 丸め（`Round`）はPythonの`round`と同じ値（2進の値で正確に中点に乗ったときだけ偶数の側）。
"""

from collections.abc import Callable, Mapping, Sequence
from functools import reduce
from typing import Annotated, Literal, Union

import numpy as np
from numpy.typing import ArrayLike
from pydantic import ConfigDict, Field

from app.domain.axis_templates import evaluate_breakpoint_linear
from app.domain.difficulty import round_difficulty_array
from app.domain.strict_model import StrictModel

_NODE_CONFIG = ConfigDict(frozen=True, allow_inf_nan=False)

#: 木が読む要求の条件の名前。地図の配信の要求のクエリパラメータの名前でもある。
_FormulaConditionName = Literal["bearing_deg", "speed_kmh"]


class Constant(StrictModel):
    model_config = _NODE_CONFIG

    op: Literal["const"] = "const"
    value: float


class Missing(StrictModel):
    """値の無いこと（NaN）。"""

    model_config = _NODE_CONFIG

    op: Literal["missing"] = "missing"


class FeatureValue(StrictModel):
    """道ごとの材料。材料の口が道ごとに同じ名前で配る（無い道はNaN）。"""

    model_config = _NODE_CONFIG

    op: Literal["feature"] = "feature"
    name: str = Field(min_length=1)


class Condition(StrictModel):
    """要求の条件（全道路に同じ値）。"""

    model_config = _NODE_CONFIG

    op: Literal["condition"] = "condition"
    name: _FormulaConditionName


class Unary(StrictModel):
    """1つを受ける演算。`sin`・`cos`は度ではなくラジアン。`is_missing`はNaNなら真。"""

    model_config = _NODE_CONFIG

    op: Literal["neg", "abs", "sin", "cos", "sqrt", "not", "is_missing"]
    arg: "FormulaNode"


class Binary(StrictModel):
    """2つを受ける演算。比べ（`lt`等）と論理（`and`・`or`）は真偽を返す。"""

    model_config = _NODE_CONFIG

    op: Literal["add", "sub", "mul", "div", "mod", "lt", "le", "gt", "ge", "and", "or"]
    left: "FormulaNode"
    right: "FormulaNode"


class Case(StrictModel):
    """`when`が真なら`then`、そうでなければ`otherwise`。"""

    model_config = _NODE_CONFIG

    op: Literal["case"] = "case"
    when: "FormulaNode"
    then: "FormulaNode"
    otherwise: "FormulaNode"


class Interpolate(StrictModel):
    """折れ線（`stops`は横軸の昇順の`(x, y)`）。両端の外は端の値で頭打ちにする。"""

    model_config = _NODE_CONFIG

    op: Literal["interpolate"] = "interpolate"
    input: "FormulaNode"
    stops: list[tuple[float, float]] = Field(min_length=1)


class Round(StrictModel):
    """小数`decimals`桁への丸め。"""

    model_config = _NODE_CONFIG

    op: Literal["round"] = "round"
    arg: "FormulaNode"
    decimals: int = Field(ge=0)


FormulaNode = Annotated[
    Union[Constant, Missing, FeatureValue, Condition, Unary, Binary, Case, Interpolate, Round],
    Field(discriminator="op"),
]

for _model in (Unary, Binary, Case, Interpolate, Round):
    _model.model_rebuild()


class WayValueFormula(StrictModel):
    """道ごとに地図が塗る値の木。`undetermined`が真の道は、その条件では値が決まらない（地図は「向きで決まらない」）。
    `undetermined`が偽で`value`がNaNの道は、値が無い（地図は「データなし」）。"""

    model_config = ConfigDict(frozen=True)

    value: FormulaNode
    undetermined: FormulaNode

    def names_read(self, leaf: type[FeatureValue | Condition]) -> set[str]:
        """木が読む道ごとの材料（`FeatureValue`）か要求の条件（`Condition`）の名前。"""
        return _names_read(self.value, leaf) | _names_read(self.undetermined, leaf)


TRUE = Constant(value=1.0)
FALSE = Constant(value=0.0)


def const(value: float) -> Constant:
    return Constant(value=value)


def feature(name: str) -> FeatureValue:
    return FeatureValue(name=name)


def condition(name: _FormulaConditionName) -> Condition:
    return Condition(name=name)


def add(left: FormulaNode, right: FormulaNode) -> Binary:
    return Binary(op="add", left=left, right=right)


def sub(left: FormulaNode, right: FormulaNode) -> Binary:
    return Binary(op="sub", left=left, right=right)


def mul(left: FormulaNode, right: FormulaNode) -> Binary:
    return Binary(op="mul", left=left, right=right)


def div(left: FormulaNode, right: FormulaNode) -> Binary:
    return Binary(op="div", left=left, right=right)


def case(when: FormulaNode, then: FormulaNode, otherwise: FormulaNode) -> Case:
    return Case(when=when, then=then, otherwise=otherwise)


def any_of(nodes: Sequence[FormulaNode]) -> FormulaNode:
    """どれかが真なら真（空なら偽）。"""
    return reduce(lambda left, right: Binary(op="or", left=left, right=right), nodes) if nodes else FALSE


def all_of(nodes: Sequence[FormulaNode]) -> FormulaNode:
    """どれもが真なら真（空なら真）。"""
    return reduce(lambda left, right: Binary(op="and", left=left, right=right), nodes) if nodes else TRUE


def _names_read(node: FormulaNode, leaf: type[FeatureValue | Condition]) -> set[str]:
    if isinstance(node, leaf):
        return {node.name}
    return set().union(*(_names_read(child, leaf) for child in _children(node)))


def _children(node: FormulaNode) -> tuple[FormulaNode, ...]:
    if isinstance(node, (Unary, Round)):
        return (node.arg,)
    if isinstance(node, Binary):
        return (node.left, node.right)
    if isinstance(node, Case):
        return (node.when, node.then, node.otherwise)
    if isinstance(node, Interpolate):
        return (node.input,)
    return ()


def _truth(values: np.ndarray) -> np.ndarray:
    return ~np.isnan(values) & (values != 0)


def _flag(mask: np.ndarray) -> np.ndarray:
    return mask.astype(float)


_UNARY: dict[str, Callable[[np.ndarray], np.ndarray]] = {
    "neg": np.negative,
    "abs": np.abs,
    "sin": np.sin,
    "cos": np.cos,
    "sqrt": np.sqrt,
    "not": lambda values: _flag(~_truth(values)),
    "is_missing": lambda values: _flag(np.isnan(values)),
}

_BINARY: dict[str, Callable[[np.ndarray, np.ndarray], np.ndarray]] = {
    "add": np.add,
    "sub": np.subtract,
    "mul": np.multiply,
    "div": np.divide,
    "mod": np.fmod,
    "lt": lambda a, b: _flag(np.less(a, b)),
    "le": lambda a, b: _flag(np.less_equal(a, b)),
    "gt": lambda a, b: _flag(np.greater(a, b)),
    "ge": lambda a, b: _flag(np.greater_equal(a, b)),
    "and": lambda a, b: _flag(_truth(a) & _truth(b)),
    "or": lambda a, b: _flag(_truth(a) | _truth(b)),
}


def evaluate_formula(
    node: FormulaNode,
    features: Mapping[str, ArrayLike],
    conditions: Mapping[str, float],
    length: int | None = None,
) -> np.ndarray:
    """木を評価する。`features`は材料の名前→値（配列どうしはnumpyの規則で揃え、無い材料はNaN）。`length`を渡すと
    長さ`length`の配列へ揃えて返す（材料を読まない木も道の数だけの値になる）。
    `conditions`に無い条件を読む木は`KeyError`で落ちる（要る条件の欠けは呼ぶ側が先に断る）。"""
    with np.errstate(invalid="ignore", divide="ignore"):
        values = _evaluate(node, features, conditions)
    return values if length is None else np.broadcast_to(values, (length,)).copy()


def _evaluate(node: FormulaNode, features: Mapping[str, ArrayLike], conditions: Mapping[str, float]) -> np.ndarray:
    if isinstance(node, Constant):
        return np.asarray(node.value, dtype=float)
    if isinstance(node, Missing):
        return np.asarray(np.nan)
    if isinstance(node, FeatureValue):
        return np.asarray(features.get(node.name, np.nan), dtype=float)
    if isinstance(node, Condition):
        return np.asarray(conditions[node.name], dtype=float)
    if isinstance(node, Unary):
        return _UNARY[node.op](_evaluate(node.arg, features, conditions))
    if isinstance(node, Binary):
        return _BINARY[node.op](_evaluate(node.left, features, conditions), _evaluate(node.right, features, conditions))
    if isinstance(node, Case):
        return np.where(
            _truth(_evaluate(node.when, features, conditions)),
            _evaluate(node.then, features, conditions),
            _evaluate(node.otherwise, features, conditions),
        )
    if isinstance(node, Interpolate):
        return evaluate_breakpoint_linear(_evaluate(node.input, features, conditions), node.stops)
    values = _evaluate(node.arg, features, conditions)
    if node.decimals == 1:
        return np.reshape(round_difficulty_array(np.atleast_1d(values)), np.shape(values))
    # `np.float64`の`round`はnumpyの丸め（10の冪を掛けて丸める）で、Pythonの`round`と値が食い違いうる。
    return np.vectorize(lambda value: round(float(value), node.decimals), otypes=[float])(values)


def way_values_from_formula(
    formula: WayValueFormula,
    feature_keys: Sequence[str],
    features: Mapping[str, ArrayLike],
    conditions: Mapping[str, float],
) -> dict[str, float | None]:
    """道の鍵→地図が塗る値。値の決まらない道はNone、値の無い道は鍵ごと除く。"""
    length = len(feature_keys)
    undetermined = _truth(evaluate_formula(formula.undetermined, features, conditions, length))
    values = evaluate_formula(formula.value, features, conditions, length)
    out: dict[str, float | None] = {}
    for key, value, unknown in zip(feature_keys, values.tolist(), undetermined.tolist()):
        if unknown:
            out[key] = None
        elif not np.isnan(value):
            out[key] = value
    return out
