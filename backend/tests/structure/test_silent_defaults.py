"""本番の作り手・呼び手が使わない既定値が、`backend/app`に無いことの検査。

既定値は「渡さない呼び手がいる」ことの宣言である。渡さない呼び手がいない既定値は、新しく足した呼び手が渡し忘れても
黙って通し、出どころの無い値を後段へ流す。

1. **StrictModelの欄**: `app`の中で`domain/strict_model.py: StrictModel`を継ぐクラスの、既定値を持つ欄を、
   そのクラスを直接呼ぶ`app`の中の作り手（`Cls(...)`）と1欄ずつ突き合わせる。どの作り手も渡さない欄（後段の
   `model_copy`等の上書きでしか埋まらない）と、全部の作り手が渡す欄（誰も既定値を使わない）を落とす。
   上書きでしか埋まらない欄は、組み立て途中の型と応答の型を分け、応答の型で必須にする。
2. **関数の引数**: `app`の最上位の関数とクラスのメソッドの、既定値を持つ引数のうち、`app`の中の呼び出しが
   全部その引数を渡しているものを落とす。テスト・ベンチ・道具は呼び手に数えない。

拾わない形:
- `*`・`**`で渡す呼び出しを持つ型・関数は判断しない（どの欄・引数を渡したかが読めない）。
- 入力として検証される型（`model_validate`・`model_validate_json`・`TypeAdapter`の対象、ルーターの入口の
  引数の型と、それらの欄の型の中に入る型）は、既定値が外から来る値の省略を受けるので判断しない。
- 関数の名前が呼び出し以外で参照される（関数を値として渡す）なら、呼び手を数えきれないので判断しない。
  呼び出しは名前（`f`・`obj.f`）で突き合わせ、同じ名前の定義が複数あれば、キーワードで渡した引数だけを数える。
- `__init__`等の特殊メソッドと、frontendの既定値は見ない。

ここで見ないもの:
- StrictModelが未知の欄を断ること → `tests/test_strict_model.py`
"""

from __future__ import annotations

import ast
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from tests.structure.source_symbols import Scope, SourceTree, Symbol, called_name

BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent

STRICT_MODEL = ("app.domain.strict_model", "StrictModel")

#: 入力として検証する呼び出し（`Cls.model_validate(...)`）。
_VALIDATING_METHODS = frozenset({"model_validate", "model_validate_json"})
#: ルーターの入口を宣言するデコレータ（`@router.get(...)`）。
_ROUTE_DECORATORS = frozenset({"get", "post", "put", "patch", "delete"})

@dataclass(frozen=True)
class _Class:
    module: str
    node: ast.ClassDef
    scope: Scope
    path: str


def _app_modules(source: SourceTree) -> dict[str, tuple[Path, ast.Module, Scope]]:
    out = {}
    for path in sorted((source.root / "app").rglob("*.py")):
        module = source.module_of(path)
        tree = source.tree(module)
        if tree is not None:
            out[module] = (path, tree, Scope(source, module, tree))
    return out


def _class_key(symbol: Symbol | None) -> tuple[str, str] | None:
    if symbol is None or symbol.kind != "class" or not isinstance(symbol.node, ast.ClassDef):
        return None
    return symbol.module, symbol.node.name


def _is_starred(call: ast.Call) -> bool:
    return any(isinstance(arg, ast.Starred) for arg in call.args) or any(kw.arg is None for kw in call.keywords)


def _has_default(statement: ast.AnnAssign) -> bool:
    value = statement.value
    if value is None:
        return False
    if isinstance(value, ast.Call) and called_name(value) == "Field":
        keywords = {kw.arg for kw in value.keywords}
        if keywords & {"default", "default_factory"}:
            return True
        return bool(value.args) and not (isinstance(value.args[0], ast.Constant) and value.args[0].value is Ellipsis)
    return not (isinstance(value, ast.Call) and called_name(value) == "PrivateAttr")


def _is_marker(annotation: ast.expr) -> bool:
    """値が1つだけの`Literal`（判別用の印）か、`ClassVar`か。"""
    if isinstance(annotation, ast.Subscript) and isinstance(annotation.value, (ast.Name, ast.Attribute)):
        name = annotation.value.id if isinstance(annotation.value, ast.Name) else annotation.value.attr
        if name == "ClassVar":
            return True
        if name == "Literal":
            return not isinstance(annotation.slice, ast.Tuple)
    return False


def _declared_fields(cls: _Class) -> dict[str, ast.AnnAssign]:
    return {
        statement.target.id: statement
        for statement in cls.node.body
        if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name)
        and not statement.target.id.startswith("_") and not _is_marker(statement.annotation)
    }


def _strict_classes(modules: dict[str, tuple[Path, ast.Module, Scope]], root: Path) -> dict[tuple[str, str], _Class]:
    classes: dict[tuple[str, str], _Class] = {}
    for module, (path, tree, scope) in modules.items():
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                classes[(module, node.name)] = _Class(module, node, scope, path.relative_to(root).as_posix())
    parents = {key: [_class_key(cls.scope.resolve(base)) for base in cls.node.bases] for key, cls in classes.items()}

    def strict(key: tuple[str, str] | None, depth: int = 0) -> bool:
        if key == STRICT_MODEL:
            return True
        return key in parents and depth < 20 and any(strict(parent, depth + 1) for parent in parents[key])

    return {key: cls for key, cls in classes.items() if key != STRICT_MODEL and strict(key)}


def _all_fields(key: tuple[str, str], classes: dict[tuple[str, str], _Class]) -> dict[str, ast.AnnAssign]:
    """継いだ欄も含めた欄。子のクラスが同じ名前を宣言し直したら子の宣言を取る。"""
    cls = classes[key]
    out: dict[str, ast.AnnAssign] = {}
    for base in cls.node.bases:
        parent = _class_key(cls.scope.resolve(base))
        if parent in classes:
            out.update(_all_fields(parent, classes))
    out.update(_declared_fields(cls))
    return out


def _named_classes(scope: Scope, expr: ast.AST) -> set[tuple[str, str] | None]:
    return {_class_key(scope.resolve(name)) for name in ast.walk(expr) if isinstance(name, (ast.Name, ast.Attribute))}


def _validated_inputs(
    modules: dict[str, tuple[Path, ast.Module, Scope]], classes: dict[tuple[str, str], _Class]
) -> set[tuple[str, str]]:
    """入力として検証される型と、その欄の型の中に入る型。"""
    seeds: set[tuple[str, str] | None] = set()
    for _, tree, scope in modules.values():
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in _VALIDATING_METHODS:
                seeds.add(_class_key(scope.resolve(node.func.value)))
            elif isinstance(node, ast.Call) and called_name(node) == "TypeAdapter":
                for arg in node.args:
                    seeds |= _named_classes(scope, arg)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and any(
                isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr in _ROUTE_DECORATORS
                for d in node.decorator_list
            ):
                for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
                    if arg.annotation is not None:
                        seeds |= _named_classes(scope, arg.annotation)
    found: set[tuple[str, str]] = set()
    pending = [key for key in seeds if key in classes]
    while pending:
        key = pending.pop()
        if key in found:
            continue
        found.add(key)
        for statement in _all_fields(key, classes).values():
            pending += [nested for nested in _named_classes(classes[key].scope, statement.annotation) if nested in classes]
    return found


def silent_model_defaults(root: Path) -> dict[str, str]:
    """作り手が渡さない欄・誰も既定値を使わない欄（`パス: クラス.欄` → どちらか）。"""
    source = SourceTree(root)
    modules = _app_modules(source)
    classes = _strict_classes(modules, root)
    validated = _validated_inputs(modules, classes)
    producers: dict[tuple[str, str], list[ast.Call]] = defaultdict(list)
    for _, tree, scope in modules.values():
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                key = _class_key(scope.resolve(node.func))
                if key in classes:
                    producers[key].append(node)
    out: dict[str, str] = {}
    for key, cls in classes.items():
        calls = producers.get(key, [])
        if not calls or key in validated or any(_is_starred(call) for call in calls):
            continue
        for name, statement in _all_fields(key, classes).items():
            if not _has_default(statement):
                continue
            passed = sum(any(kw.arg == name for kw in call.keywords) for call in calls)
            if passed == 0:
                out[f"{cls.path}: {cls.node.name}.{name}"] = "作り手が渡さない"
            elif passed == len(calls):
                out[f"{cls.path}: {cls.node.name}.{name}"] = "誰も既定値を使わない"
    return out


def _defaulted_parameters(function: ast.FunctionDef | ast.AsyncFunctionDef, method: bool) -> list[tuple[str, int | None]]:
    """既定値を持つ引数と、呼び出しで位置引数として渡すときの位置（キーワード専用ならNone）。"""
    arguments = function.args
    positional = arguments.posonlyargs + arguments.args
    is_static = any(isinstance(d, ast.Name) and d.id == "staticmethod" for d in function.decorator_list)
    offset = 1 if method and not is_static and positional else 0
    first_default = len(positional) - len(arguments.defaults)
    out: list[tuple[str, int | None]] = [
        (argument.arg, index - offset) for index, argument in enumerate(positional) if index >= first_default
    ]
    out += [(argument.arg, None) for argument, default in zip(arguments.kwonlyargs, arguments.kw_defaults)
            if default is not None]
    return out


def always_passed_defaults(root: Path) -> list[str]:
    """`app`の中の呼び出しが全部渡している、既定値つきの引数（`パス: 関数(引数)`）。"""
    source = SourceTree(root)
    definitions: dict[str, list[tuple[str, ast.FunctionDef | ast.AsyncFunctionDef, bool]]] = defaultdict(list)
    calls: dict[str, list[ast.Call]] = defaultdict(list)
    referenced: set[str] = set()
    for path, tree, _ in _app_modules(source).values():
        relative = path.relative_to(root).as_posix()
        for top in tree.body:
            if isinstance(top, (ast.FunctionDef, ast.AsyncFunctionDef)):
                definitions[top.name].append((relative, top, False))
            elif isinstance(top, ast.ClassDef):
                for method in top.body:
                    if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        definitions[method.name].append((relative, method, True))
        callees = {id(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and (name := called_name(node)):
                calls[name].append(node)
            if isinstance(node, (ast.Name, ast.Attribute)) and isinstance(node.ctx, ast.Load) and id(node) not in callees:
                referenced.add(node.id if isinstance(node, ast.Name) else node.attr)
    out: list[str] = []
    for name, defined in definitions.items():
        found = calls.get(name, [])
        if name.startswith("__") or not found or name in referenced or any(_is_starred(call) for call in found):
            continue
        for path, function, method in defined:
            for parameter, position in _defaulted_parameters(function, method):
                at = position if len(defined) == 1 else None
                if all(
                    any(kw.arg == parameter for kw in call.keywords) or (at is not None and len(call.args) > at)
                    for call in found
                ):
                    out.append(f"{path}: {name}({parameter})")
    return sorted(out)


def test_model_defaults_are_used_by_some_producer() -> None:
    violations = silent_model_defaults(BACKEND_ROOT)

    assert violations == {}, (
        "StrictModelの既定値を、本番の作り手が一部だけ省くようにする。どの作り手も渡さない欄は"
        "組み立て途中の型と応答の型を分けて応答の型で必須にし、全部の作り手が渡す欄は既定値を外す:\n  "
        + "\n  ".join(f"{field}（{reason}）" for field, reason in sorted(violations.items()))
    )


def test_function_defaults_are_omitted_by_some_caller() -> None:
    violations = always_passed_defaults(BACKEND_ROOT)

    assert violations == [], (
        "`app`の中の呼び出しが全部渡している引数の既定値を外す（テストは組み立ての関数で値を渡す）:\n  "
        + "\n  ".join(violations)
    )


def _write(root: Path, relative: str, text: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_detects_model_defaults_without_a_use(tmp_path: Path) -> None:
    """作り手が渡さない欄と全部の作り手が渡す欄を落とし、一部の作り手が省く欄と入力として検証する型は落とさない。"""
    _write(tmp_path, "app/domain/strict_model.py", (
        "from pydantic import BaseModel\n\n\n"
        "class StrictModel(BaseModel):\n"
        "    pass\n"
    ))
    _write(tmp_path, "app/domain/route.py", (
        "from pydantic import Field\n"
        "from app.domain.strict_model import StrictModel\n\n\n"
        "class Draft(StrictModel):\n"
        "    distance_km: float\n"
        "    turns: list[int] = Field(default_factory=list)\n"
        "    overall: float | None = None\n"
        "    note: str = ''\n\n\n"
        "class Request(StrictModel):\n"
        "    limit: int = 3\n"
    ))
    _write(tmp_path, "app/services/engine.py", (
        "from app.domain.route import Draft, Request\n\n\n"
        "def build():\n"
        "    request = Request.model_validate({})\n"
        "    Request(limit=1)\n"
        "    first = Draft(distance_km=1.0, turns=[], note='a')\n"
        "    second = Draft(distance_km=2.0, turns=[1])\n"
        "    return [d.model_copy(update={'overall': 1.0}) for d in (first, second)], request\n"
    ))

    assert silent_model_defaults(tmp_path) == {
        "app/domain/route.py: Draft.turns": "誰も既定値を使わない",
        "app/domain/route.py: Draft.overall": "作り手が渡さない",
    }


def test_detects_a_default_every_caller_passes(tmp_path: Path) -> None:
    """全部の呼び出しが位置かキーワードで渡す引数を落とし、省く呼び出しのある引数と値として渡す関数は落とさない。"""
    _write(tmp_path, "app/services/route_generator.py", (
        "class RouteGenerator:\n"
        "    async def generate_loops(self, origin, distance_km, points=None, *, max_routes=5):\n"
        "        return origin\n\n\n"
        "def callback(value=0):\n"
        "    return value\n"
    ))
    _write(tmp_path, "app/api/routes.py", (
        "from app.services.route_generator import RouteGenerator, callback\n\n\n"
        "async def handler(generator: RouteGenerator, points):\n"
        "    await generator.generate_loops(1, 2, points)\n"
        "    await generator.generate_loops(1, 2, points=points, max_routes=3)\n"
        "    callback(1)\n"
        "    return list(map(callback, [1]))\n"
    ))

    assert always_passed_defaults(tmp_path) == ["app/services/route_generator.py: generate_loops(points)"]
