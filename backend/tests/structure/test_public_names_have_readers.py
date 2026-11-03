"""`app`の最上位の公開名に、定義のほかの読み手があることの検査。

読み手の無い公開名は、呼び手を消したときの取り残しで、動作には現れない（frontend は knip が落とす）。

母集団はソースから導く——`app`配下の全`.py`の最上位で、`def`・`class`・代入が定義する`_`で始まらない名前。
読み手は`backend`のファイル（追跡下と、まだ`git add`していない無視されていないもの）から数える。
- `.py`は名前の読み出し・属性・取り込み・名前そのものか`"app.x.名前"`の形の文字列（`setattr`・`patch`へ渡すもの）
- ほかのファイル（`Dockerfile`・シェル等が`python -c`で呼ぶもの）は綴り。文書（`.md`）は読み手に数えない
- 定義に付けた`app`の口のデコレータ（`@router.get`・`@register_adapter`）と、表を宣言するクラスの登録（`__tablename__`）

テストだけが読む名前は、テストを読み手に数えてよい3つ（.claude/rules/testing.md「確かめる高さ」の (a)〜(c)）に当たるときだけ
読まれたに数える。(a) は`global`を書かない関数とクラス、(b) はテストが算術の項に使う値、(c) はテストが差し替える値として見る。

**判定しない形**: 名前で読み手を数えるので、同じ名前を別のモジュールが定義していれば、どちらの読み手にも数える（見逃す側に倒れる）。
"""

from __future__ import annotations

import ast
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


def _definitions(tree: ast.Module) -> Iterator[tuple[str, ast.stmt]]:
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            yield stmt.name, stmt
        elif isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    yield target.id, stmt


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
    if isinstance(stmt, ast.ClassDef):
        return True
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return not any(isinstance(node, ast.Global) for node in ast.walk(stmt))
    return bool(hows & {"replaced", "operand"})


def unread_names(root: Path) -> list[str]:
    """`root`（`backend`）の`app`で、定義のほかに読み手の無い最上位の公開名（`パス: 名前`）。"""
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
        for name, stmt in _definitions(tree):
            if name.startswith("_") or _registered(scope, stmt):
                continue
            outside_tests = {r for r in readers.get(name, set()) if not r.startswith(f"{TESTS}/")}
            if outside_tests:
                continue
            if name in test_reads and _allowed_from_tests(stmt, test_reads[name]):
                continue
            found.append(f"{relative}: {name}")
    return found


def test_public_names_have_readers() -> None:
    violations = unread_names(BACKEND_ROOT)

    assert violations == [], (
        "定義のほかに読み手の無い公開名がある。呼び手を消したなら一緒に消し、テストだけが読むなら"
        ".claude/rules/testing.md「確かめる高さ」の (a)〜(c) に当たる形にすること:\n  " + "\n  ".join(violations)
    )


def test_detects_names_without_readers(tmp_path: Path) -> None:
    """検査が効いていること。落とす側は、読み手の無い値と、テストが読むだけの値・モジュールの状態を書く関数。
    落とさない側は、別のモジュール・同じモジュール・`Dockerfile`が読む名前、`app`の口のデコレータと表の宣言、
    テストが算術の項に使う値・差し替える値・呼ぶ計算。"""
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    write_files(tmp_path, {
        "app/__init__.py": "",
        "app/registry.py": "def register(fn):\n    return fn\n",
        "app/models.py": (
            "from app.registry import register\n"
            "from dataclasses import dataclass\n\n"
            "UNREAD = 1\nCOUNTER = 2\nREAD_ELSEWHERE = 3\n"
            "COMPARED_IN_TEST = 4\nLIMIT = 5\nROOT = 'r'\nIN_DOCKERFILE = 6\nIN_DOCS = 7\n"
            "_PRIVATE = 8\n\n\n"
            "def compute(x):\n    return x\n\n\n"
            "def reset_state():\n    global COUNTER\n    COUNTER = COUNTER + 1\n\n\n"
            "@register\ndef handler():\n    return 0\n\n\n"
            "@dataclass\nclass UnreadValue:\n    x: int\n\n\n"
            "class Row:\n    __tablename__ = 'rows'\n"
        ),
        "app/user.py": "from app.models import READ_ELSEWHERE\n",
        "Dockerfile": 'RUN python -c "from app.models import IN_DOCKERFILE"\n',
        "README.md": "`IN_DOCS`\n",
        "tests/__init__.py": "",
        "tests/test_models.py": (
            "from app import models\n\n\n"
            "def test_x(monkeypatch):\n"
            "    monkeypatch.setattr(models, 'ROOT', 'x')\n"
            "    assert models.COMPARED_IN_TEST == 4\n"
            "    assert models.compute(models.LIMIT + 1)\n"
            "    models.reset_state()\n"
        ),
    })

    assert unread_names(tmp_path) == [
        "app/models.py: UNREAD",
        "app/models.py: COMPARED_IN_TEST",
        "app/models.py: IN_DOCS",
        "app/models.py: reset_state",
        "app/models.py: UnreadValue",
    ]
