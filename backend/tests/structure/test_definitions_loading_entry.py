"""DBの定義（道の区分・軸定義・較正値）をプロセスへ読み込む関数を、`services/definitions_loading.py: refresh_definitions`の
外から呼んでいないことの検査。

外から1つだけ呼ぶ入口（起動を通らない道具）は、読む順を写し損ねる——区分を読まずに軸定義を読むと、区分から作る材料を
指す軸が「存在しない材料」として断られ、本番のデータでだけ読み込みが落ちる（テストのDBの軸は区分を指さないことが多い）。

母集団はソースから導く（`backend`のテストを除く全`.py`）。名前を値として参照する所を数えるので、呼び出しのほかに
関数を参照で渡す形（`asyncio.to_thread(f, ...)`）と、属性を文字列で指す形（`getattr(mod, "f")`）も拾う。

ここで見ないもの:
- 読む順そのものと、区分を指す軸が読み込まれること → `tests/test_definitions_loading.py`
"""

from __future__ import annotations

import ast
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[2]

LOADERS = frozenset({"refresh_road_classes", "refresh_axis_definitions", "refresh_tuning_values"})

# 読み込む関数を直接参照してよい所と、その理由。
ALLOWED = {
    ("app/services/definitions_loading.py", "refresh_road_classes"): "読む順を持つ1つの入口",
    ("app/services/definitions_loading.py", "refresh_axis_definitions"): "読む順を持つ1つの入口",
    ("app/services/definitions_loading.py", "refresh_tuning_values"): "読む順を持つ1つの入口",
    ("app/services/axis_registry_service.py", "refresh_axis_definitions"): (
        "管理APIの書き込みの直後の読み直し。区分は読み込み済みのプロセスで、書いた軸定義だけを読み直す"
    ),
}


def _referenced_loaders(tree: ast.AST) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            name = node.id
        elif isinstance(node, ast.Attribute):
            name = node.attr
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            name = node.value
        else:
            continue
        if name in LOADERS:
            found.add(name)
    return found


def loader_references(root: Path) -> set[tuple[str, str]]:
    """テストを除く`root`配下の`.py`で、読み込む関数を値として参照している（ファイル, 関数の名前）。"""
    out: set[tuple[str, str]] = set()
    for path in sorted(root.rglob("*.py")):
        relative = path.relative_to(root)
        if relative.parts[0] == "tests" or any(part.startswith(".") for part in relative.parts):
            continue
        for name in _referenced_loaders(ast.parse(path.read_text(encoding="utf-8"))):
            out.add((relative.as_posix(), name))
    return out


def test_definitions_are_loaded_only_through_the_single_entry() -> None:
    unexpected = sorted(loader_references(BACKEND_ROOT) - ALLOWED.keys())
    assert unexpected == [], (
        "区分・軸定義・較正値を読み込む関数を直接呼んでいる所がある"
        "（`services/definitions_loading.py: refresh_definitions`を呼ぶこと）:\n  "
        + "\n  ".join(f"{path}: {name}" for path, name in unexpected)
    )


def test_allowlist_has_no_stale_entries() -> None:
    stale = sorted(ALLOWED.keys() - loader_references(BACKEND_ROOT))
    assert stale == [], f"参照が無くなったのに許可に残っている: {stale}"
