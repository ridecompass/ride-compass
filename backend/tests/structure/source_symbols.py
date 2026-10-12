"""`backend`のソースを import せずに読み、名前がどこで定義されたかを辿る。

構造テストはコードを動かさずに読む（.claude/rules/testing-structure.md「ソースを読む検査は、専用ディレクトリへ置く」）。
名前の定義元は、モジュールの最上位の束縛（`def`・`class`・`import`・代入）を辿って決める。
ファイルとモジュールの名前の対応・相対の取り込み・テストの母集団・差し替えの読み方は、ここが1か所で持つ。
`backend/scripts`の道具も`backend`を`sys.path`へ足してここから読む。
"""

from __future__ import annotations

import ast
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Literal


@dataclass(frozen=True)
class Symbol:
    """名前が指すもの。`module`は定義したモジュール（`kind`が`module`ならそのモジュール自身）。"""

    kind: Literal["module", "function", "class", "data"]
    module: str
    node: ast.AST | None = None


def bound_names(statements: list[ast.stmt]) -> dict[str, ast.AST]:
    """最上位の文が束縛する名前と、束縛した文（`if`・`try`・`with`の中も最上位として読む）。"""
    out: dict[str, ast.AST] = {}
    for stmt in statements:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out[stmt.name] = stmt
        elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
            for alias in stmt.names:
                out[alias.asname or alias.name.split(".")[0]] = stmt
        elif isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            for target in targets:
                for name in ast.walk(target):
                    if isinstance(name, ast.Name) and isinstance(name.ctx, ast.Store):
                        out[name.id] = stmt
        elif isinstance(stmt, (ast.If, ast.Try, ast.With)):
            nested = list(stmt.body) + list(getattr(stmt, "orelse", [])) + list(getattr(stmt, "finalbody", []))
            for handler in getattr(stmt, "handlers", []):
                nested += handler.body
            out.update(bound_names(nested))
    return out


class SourceTree:
    """`root`（`backend`）直下のパッケージのソース。"""

    def __init__(self, root: Path):
        self.root = root
        self._trees: dict[str, ast.Module | None] = {}

    def path_of(self, module: str) -> Path | None:
        """モジュールのファイル。同じ名前のパッケージとファイルがあればパッケージ（Python の読み込みと同じ）。"""
        base = self.root.joinpath(*module.split("."))
        for path in (base / "__init__.py", base.with_suffix(".py")):
            if path.is_file():
                return path
        return None

    def module_of(self, path: Path) -> str:
        """ファイルのモジュールの名前（`__init__.py`はパッケージの名前）。"""
        parts = list(path.relative_to(self.root).with_suffix("").parts)
        return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)

    def tree(self, module: str) -> ast.Module | None:
        if module not in self._trees:
            path = self.path_of(module)
            self._trees[module] = ast.parse(path.read_text(encoding="utf-8")) if path else None
        return self._trees[module]

    def absolute(self, module: str, node: ast.ImportFrom) -> str:
        """`module`の中の`from … import`が読むモジュールの名前（相対の取り込みも絶対の名前にする）。"""
        if not node.level:
            return node.module or ""
        package = module.split(".")
        is_package = (self.path_of(module) or Path()).name == "__init__.py"
        base = package if is_package else package[:-1]
        base = base[: len(base) - (node.level - 1)]
        return ".".join(base + ([node.module] if node.module else []))

    def _from_import(self, module: str, node: ast.ImportFrom, name: str, depth: int) -> Symbol | None:
        source = self.absolute(module, node)
        if self.path_of(f"{source}.{name}"):
            return Symbol("module", f"{source}.{name}")
        return self.lookup(source, name, depth + 1)

    def binding(self, module: str, name: str, statement: ast.AST, depth: int = 0) -> Symbol | None:
        """`module`の中で`statement`が束縛した`name`が指すもの。"""
        if depth > 20:
            return None
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return Symbol("function", module, statement)
        if isinstance(statement, ast.ClassDef):
            return Symbol("class", module, statement)
        if isinstance(statement, ast.Import):
            for alias in statement.names:
                if alias.asname == name:
                    return Symbol("module", alias.name)
                if alias.asname is None and alias.name.split(".")[0] == name:
                    return Symbol("module", name)
            return None
        if isinstance(statement, ast.ImportFrom):
            for alias in statement.names:
                if (alias.asname or alias.name) == name:
                    return self._from_import(module, statement, alias.name, depth)
            return None
        return Symbol("data", module, statement)

    def lookup(self, module: str, name: str, depth: int = 0) -> Symbol | None:
        """`module`の最上位の名前`name`が指すもの。ソースが手元に無いモジュール（標準・外部）はNone。"""
        tree = self.tree(module)
        if tree is None or depth > 20:
            return None
        statement = bound_names(tree.body).get(name)
        if statement is not None:
            return self.binding(module, name, statement, depth)
        if self.path_of(f"{module}.{name}"):
            return Symbol("module", f"{module}.{name}")
        return None

    def attribute(self, owner: Symbol, name: str) -> Symbol | None:
        """`owner.name`が指すもの（モジュールの名前か、クラスの本体で定義した名前）。"""
        if owner.kind == "module":
            return self.lookup(owner.module, name)
        if owner.kind == "class" and isinstance(owner.node, ast.ClassDef):
            statement = bound_names(owner.node.body).get(name)
            if statement is not None:
                return self.binding(owner.module, name, statement)
        return None

    def dotted(self, path: str) -> tuple[Symbol, str] | None:
        """`"app.x.y.name"`の形の差し替え先を、持ち主と名前に分ける。"""
        parts = path.split(".")
        for cut in range(len(parts) - 1, 0, -1):
            owner_module = ".".join(parts[:cut])
            if self.path_of(owner_module) is None:
                continue
            owner: Symbol | None = Symbol("module", owner_module)
            for part in parts[cut:-1]:
                owner = self.attribute(owner, part) if owner else None
            return (owner, parts[-1]) if owner else None
        return None


class Scope:
    """ソースの1ファイルの中で、式が指すものを辿る。関数の中の import もファイル全体の束縛として読む。"""

    def __init__(self, source: SourceTree, module: str, tree: ast.Module):
        self.source = source
        self.module = module
        self.names = bound_names(tree.body)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    self.names.setdefault(alias.asname or alias.name.split(".")[0], node)

    def resolve(self, expr: ast.expr) -> Symbol | None:
        if isinstance(expr, ast.Name):
            statement = self.names.get(expr.id)
            return self.source.binding(self.module, expr.id, statement) if statement is not None else None
        if isinstance(expr, ast.Attribute):
            owner = self.resolve(expr.value)
            return self.source.attribute(owner, expr.attr) if owner else None
        return None


#: 持ち主と名前の文字列を受けて差し替える呼び出し（`monkeypatch.setattr`・`monkeypatch.delattr`・`patch.object`）。
REPLACING_BY_NAME = frozenset({"setattr", "delattr", "object"})
#: `"app.x.y"`の道筋を受けて差し替える呼び出し（`monkeypatch.setattr`・`monkeypatch.delattr`・`patch`）。
REPLACING_BY_PATH = frozenset({"setattr", "delattr", "patch"})


def called_name(call: ast.Call) -> str | None:
    """呼び出した名前（`a.b.f(...)`なら`f`）。"""
    func = call.func
    return func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else None


def replacement_calls(tree: ast.Module) -> Iterator[tuple[ast.Call, ast.AST]]:
    """差し替えの呼び出しと、それを含む最上位の定義（関数・クラス。無ければモジュール）。"""
    for top in tree.body:
        for node in ast.walk(top):
            if isinstance(node, ast.Call) and node.args and called_name(node) in REPLACING_BY_NAME | REPLACING_BY_PATH:
                yield node, top


@dataclass(frozen=True)
class Replaced:
    """差し替えの呼び出しが差し替える先。`owner`は持ち主が決まらなければNone、`name`は名前を変数で渡せばNone。"""

    owner_text: str
    owner: Symbol | None
    name: str | None
    by_path: bool


def replacement_of(scope: Scope, call: ast.Call) -> Replaced | None:
    """差し替えの呼び出し（`replacement_calls`）が差し替える先。持ち主も名前も読めない形はNone。"""
    first = call.args[0]
    if isinstance(first, ast.Constant) and isinstance(first.value, str):
        owner_text, _, name = first.value.rpartition(".")
        split = scope.source.dotted(first.value)
        return Replaced(owner_text, split[0] if split else None, name, by_path=True)
    if len(call.args) < 2:
        return None
    second = call.args[1]
    name = second.value if isinstance(second, ast.Constant) and isinstance(second.value, str) else None
    return Replaced(ast.unparse(first), scope.resolve(first), name, by_path=False)


def scanned_tests(root: Path) -> list[Path]:
    """`root`（`backend`）の`tests`のうち、構造テストが読むファイル（構造テストのディレクトリを除く全`.py`）。"""
    tests = root / "tests"
    return [path for path in sorted(tests.rglob("*.py")) if "structure" not in path.relative_to(tests).parts]


def is_scaffold(path: Path) -> bool:
    """テストのファイルでなく、共有の足場（`conftest.py`・組み立ての関数・代役）か。"""
    return not path.name.startswith("test_")


def declares_table(tree: ast.Module) -> bool:
    """クラスの本体で`__tablename__`へ代入するか、`Table(...)`を呼ぶか。"""
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            for stmt in node.body:
                targets = stmt.targets if isinstance(stmt, ast.Assign) else [getattr(stmt, "target", None)]
                if any(isinstance(t, ast.Name) and t.id == "__tablename__" for t in targets):
                    return True
        elif isinstance(node, ast.Call) and called_name(node) == "Table":
            return True
    return False


def table_modules(root: Path) -> set[str]:
    """`root`（`backend`）の`app`で、表を宣言するモジュールの名前。"""
    source = SourceTree(root)
    return {
        source.module_of(path)
        for path in sorted((root / "app").rglob("*.py"))
        if declares_table(ast.parse(path.read_text(encoding="utf-8")))
    }
