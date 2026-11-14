"""`app`の最上位の公開名とクラスの公開メソッドに、定義のほかの読み手があることの検査。

読み手の無い公開名は、呼び手を消したときの取り残しで、動作には現れない（frontend は knip が落とす）。

母集団はソースから導く——`app`配下の全`.py`の最上位で、`def`・`class`・代入が定義する`_`で始まらない名前と、
最上位のクラスの本体で`def`が定義する`_`で始まらないメソッド。
読み手は`backend`のファイル（追跡下と、まだ`git add`していない無視されていないもの）から数える。
- `.py`は名前の読み出し・属性・取り込み・名前そのものか`"app.x.名前"`の形の文字列（`setattr`・`patch`へ渡すもの）
- ほかのファイル（`Dockerfile`・シェル等が`python -c`で呼ぶもの）は綴り。文書（`.md`）は読み手に数えない
- 定義に付けた`app`の口のデコレータ（`@router.get`・`@register_adapter`）と、表を宣言するクラスの登録（`__tablename__`）
- `app`の外の基底クラス（`logging.Formatter`等）が持つ名前のメソッドは、その外の道具が呼ぶ上書きとして読まれたに数える
  （基底クラスは`app`の中を辿り、外に出たら、その取り込みの名前で外の道具を読み込んで名前を引く）

テストだけが読む名前は、テストを読み手に数えてよい3つ（.claude/rules/testing.md「確かめる高さ」の (a)〜(c)）に当たるときだけ
読まれたに数える。(a) の関数・クラス・メソッドは、本番の読み手（定義したモジュールの中を含む）が1つ以上あることを前提にするので、
テストを読み手に数えない。(b) はテストが算術の項に使う値、(c) はテストが差し替える値として見る。

**判定しない形**: 名前で読み手を数えるので、同じ名前を別のモジュールが定義していれば、どちらの読み手にも数える（見逃す側に倒れる）。
メソッドは属性の名前で数えるので、別のクラスや外の道具の同じ名前の属性を読む所も読み手に数える。
"""

from __future__ import annotations

import ast
import importlib
import re
import subprocess
from collections.abc import Iterator
from pathlib import Path

from repo_population import read_text, repository_files
from tests.structure.source_symbols import (
    REPLACING_BY_NAME,
    REPLACING_BY_PATH,
    Scope,
    SourceTree,
    called_name,
    within,
    write_files,
)

BACKEND_ROOT = Path(__file__).resolve().parents[2]

APP = "app"
TESTS = "tests"


def _definitions(tree: ast.Module) -> Iterator[tuple[str, ast.stmt, ast.ClassDef | None]]:
    """最上位の名前と、最上位のクラスのメソッド（`クラス.名前`と持ち主のクラス）。"""
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            yield stmt.name, stmt, None
        if isinstance(stmt, ast.ClassDef):
            for body in stmt.body:
                if isinstance(body, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    yield f"{stmt.name}.{body.name}", body, stmt
        elif isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    yield target.id, stmt, None


def _registered(scope: Scope, stmt: ast.stmt) -> bool:
    """定義を読むのが登録（`app`の口のデコレータ・表の宣言）か。"""
    if isinstance(stmt, ast.ClassDef) and any(
        isinstance(target, ast.Name) and target.id == "__tablename__"
        for body in stmt.body if isinstance(body, ast.Assign) for target in body.targets
    ):
        return True
    for decorator in getattr(stmt, "decorator_list", []):
        root = decorator.func if isinstance(decorator, ast.Call) else decorator
        while isinstance(root, ast.Attribute):
            root = root.value
        symbol = scope.resolve(root)
        if symbol is not None and within(symbol.module, APP):
            return True
    return False


def _external(scope: Scope, expr: ast.expr) -> object | None:
    """`app`の外の取り込み（`logging.Formatter`・`from pydantic import BaseModel`）が指すもの。"""
    attributes: list[str] = []
    while isinstance(expr, ast.Attribute):
        attributes.insert(0, expr.attr)
        expr = expr.value
    statement = scope.names.get(expr.id) if isinstance(expr, ast.Name) else None
    if isinstance(statement, ast.Import):
        alias = next(alias for alias in statement.names if (alias.asname or alias.name.split(".")[0]) == expr.id)
        path = (alias.name if alias.asname else alias.name.split(".")[0]).split(".") + attributes
    elif isinstance(statement, ast.ImportFrom):
        alias = next(alias for alias in statement.names if (alias.asname or alias.name) == expr.id)
        path = [scope.source.absolute(scope.module, statement), alias.name, *attributes]
    else:
        return None
    found: object = importlib.import_module(path[0])
    for part in path[1:]:
        found = getattr(found, part)
    return found


def _overrides_outside(scope: Scope, owner: ast.ClassDef, name: str) -> bool:
    """`owner`の基底クラスを辿った先の`app`の外のクラスが、`name`を持つか。"""
    for base in owner.bases:
        symbol = scope.resolve(base)
        if symbol is None:
            if hasattr(_external(scope, base), name):
                return True
        elif symbol.kind == "class" and isinstance(symbol.node, ast.ClassDef):
            tree = scope.source.tree(symbol.module)
            assert tree is not None
            if _overrides_outside(Scope(scope.source, symbol.module, tree), symbol.node, name):
                return True
    return False


def _read_names(tree: ast.Module) -> Iterator[tuple[str, str]]:
    """木が読む名前と、テストを読み手に数えてよい形（`"replaced"`・`"operand"`・`"read"`）。"""
    operands = {id(side) for node in ast.walk(tree) if isinstance(node, ast.BinOp) for side in (node.left, node.right)}
    replaced = {
        id(arg)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and called_name(node) in REPLACING_BY_NAME | REPLACING_BY_PATH
        for arg in node.args[:2]
    }
    for node in ast.walk(tree):
        how = "replaced" if id(node) in replaced else "operand" if id(node) in operands else "read"
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            yield node.id, how
        elif isinstance(node, ast.Attribute):
            yield node.attr, how
        elif isinstance(node, ast.alias):
            yield node.name.split(".")[-1], how
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and re.fullmatch(r"[\w.]+", node.value):
            yield node.value.rsplit(".", 1)[-1], how


def _allowed_from_tests(stmt: ast.stmt, hows: set[str]) -> bool:
    """値をテストが読む形が (b)・(c) か。関数・クラス・メソッド（(a)）は本番の読み手を要るので、テストだけでは数えない。"""
    return isinstance(stmt, (ast.Assign, ast.AnnAssign)) and bool(hows & {"replaced", "operand"})


def unread_names(root: Path) -> list[str]:
    """`root`（`backend`）の`app`で、定義のほかに読み手の無い最上位の公開名とメソッド（`パス: 名前`・`パス: クラス.名前`）。"""
    source = SourceTree(root)
    readers: dict[str, set[str]] = {}
    test_reads: dict[str, set[str]] = {}
    trees: dict[str, ast.Module] = {}
    for relative in repository_files(root):
        if relative.endswith(".md"):
            continue
        text = read_text(root / relative)
        if not relative.endswith(".py"):
            for word in set(re.findall(r"\w+", text)):
                readers.setdefault(word, set()).add(relative)
            continue
        tree = trees[relative] = ast.parse(text)
        for name, how in _read_names(tree):
            readers.setdefault(name, set()).add(relative)
            if relative.startswith(f"{TESTS}/"):
                test_reads.setdefault(name, set()).add(how)

    found: list[str] = []
    for relative, tree in sorted(trees.items()):
        if not relative.startswith(f"{APP}/"):
            continue
        scope = Scope(source, source.module_of(root / relative), tree)
        for label, stmt, owner in _definitions(tree):
            name = label.rsplit(".", 1)[-1]
            if name.startswith("_") or _registered(scope, stmt):
                continue
            if owner is not None and _overrides_outside(scope, owner, name):
                continue
            outside_tests = {r for r in readers.get(name, set()) if not r.startswith(f"{TESTS}/")}
            if outside_tests:
                continue
            if name in test_reads and _allowed_from_tests(stmt, test_reads[name]):
                continue
            found.append(f"{relative}: {label}")
    return found


def test_public_names_have_readers() -> None:
    violations = unread_names(BACKEND_ROOT)

    assert violations == [], (
        "定義のほかに読み手の無い公開名がある。呼び手を消したなら一緒に消し、テストだけが読むなら"
        ".claude/rules/testing.md「確かめる高さ」の (a)〜(c) に当たる形にすること:\n  " + "\n  ".join(violations)
    )


def test_detects_names_without_readers(tmp_path: Path) -> None:
    """検査が効いていること。落とす側は、読み手の無い値と、テストが読むだけの値・関数・クラス・メソッド。
    落とさない側は、別のモジュール・同じモジュール・`Dockerfile`が読む名前とメソッド、`app`の口のデコレータと表の宣言、
    テストが算術の項に使う値・差し替える値、外の基底クラス（`app`の基底クラスを挟んでも）が持つ名前の上書き。"""
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    write_files(tmp_path, {
        "app/__init__.py": "",
        "app/registry.py": "import logging\n\n\ndef register(fn):\n    return fn\n\n\nclass Base(logging.Formatter):\n    pass\n",
        "app/models.py": (
            "import logging\n"
            "from app.registry import Base, register\n"
            "from dataclasses import dataclass\n\n"
            "UNREAD = 1\nREAD_ELSEWHERE = 2\n"
            "COMPARED_IN_TEST = 3\nLIMIT = 4\nROOT = 'r'\nIN_DOCKERFILE = 5\nIN_DOCS = 6\n"
            "_PRIVATE = 7\n\n\n"
            "def compute(x):\n    return x\n\n\n"
            "def used_here(x):\n    return x\n\n\n"
            "def caller():\n    return used_here(1).read_elsewhere()\n\n\n"
            "@register\ndef handler():\n    return 0\n\n\n"
            "@dataclass\nclass UnreadValue:\n    x: int\n\n\n"
            "class Row:\n    __tablename__ = 'rows'\n\n\n"
            "class Value:\n"
            "    def read_elsewhere(self):\n        return 0\n\n"
            "    def tested_only(self):\n        return 0\n\n"
            "    def unread(self):\n        return 0\n\n"
            "    def _private(self):\n        return 0\n\n\n"
            "class Formatter(logging.Formatter):\n"
            "    def formatTime(self, record, datefmt=None):\n        return ''\n\n\n"
            "class Derived(Base):\n"
            "    def format(self, record):\n        return ''\n"
        ),
        "app/user.py": "from app.models import READ_ELSEWHERE, Value, Formatter, Derived, caller\n",
        "Dockerfile": 'RUN python -c "from app.models import IN_DOCKERFILE"\n',
        "README.md": "`IN_DOCS`\n",
        "tests/__init__.py": "",
        "tests/test_models.py": (
            "from app import models\n\n\n"
            "def test_x(monkeypatch):\n"
            "    monkeypatch.setattr(models, 'ROOT', 'x')\n"
            "    assert models.COMPARED_IN_TEST == 3\n"
            "    assert models.compute(models.LIMIT + 1)\n"
            "    assert models.used_here(1)\n"
            "    assert models.UnreadValue(1)\n"
            "    assert models.Value().tested_only() == 0\n"
        ),
    })

    assert unread_names(tmp_path) == [
        "app/models.py: UNREAD",
        "app/models.py: COMPARED_IN_TEST",
        "app/models.py: IN_DOCS",
        "app/models.py: compute",
        "app/models.py: UnreadValue",
        "app/models.py: Value.tested_only",
        "app/models.py: Value.unread",
    ]
