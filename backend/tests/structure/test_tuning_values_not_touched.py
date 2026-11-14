"""テストのファイルが、プロセス内の較正値の置き場（`app/domain/tuning.py: TUNING_VALUES`）に触れていないことの検査。

テストは足場が置いたテストの較正値（`tests/tuning_fixture.py`）で入力を組み、読むときは`tuning_value`で読む。置き場を
書き換えて境界を作ると、本番に無い経路で値が変わることを確かめるだけになる（.claude/rules/testing.md「確かめる高さ」）。

母集団はソースから導く——`backend/tests`配下の、共有の足場でない全`.py`（この検査のディレクトリを除く）を読み、名前・属性の参照と、
`"app.domain.tuning.TUNING_VALUES"`の形の道筋の文字列と、持ち主と名前の文字列を受ける差し替えを、import を辿って定義元まで引く。
足場（`conftest.py`）はテストの較正値を置く持ち主なので読まない。

**判定しない形**: 持ち主を変数・引数で渡す形は、ソースから相手が決まらない。

ここで見ないもの:
- 表に書いた値が置き場まで届くこと → `test_tuning_overrides.py`
- domain の関数・クラスの差し替え → `test_domain_not_replaced.py`
"""

from __future__ import annotations

import ast
from pathlib import Path

from tests.structure.source_symbols import (
    Scope, SourceTree, is_scaffold, replacement_calls, replacement_of, scanned_tests, write_files,
)

BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent
TUNING_MODULE, TUNING_VALUES_NAME = "app.domain.tuning", "TUNING_VALUES"


def _is_dotted_path(value: object) -> bool:
    """文字列が`"a.b.c"`の形（ドットでつないだ識別子）か。"""
    return isinstance(value, str) and "." in value and all(part.isidentifier() for part in value.split("."))


def tuning_values_touched(root: Path) -> list[str]:
    """`root`（`backend`）の`tests`のテストのファイルで、較正値の置き場を指している箇所。"""
    source = SourceTree(root)
    target = source.lookup(TUNING_MODULE, TUNING_VALUES_NAME)
    assert target is not None, f"{TUNING_MODULE}.{TUNING_VALUES_NAME}が見つからない"
    out: list[str] = []
    for path in scanned_tests(root):
        if is_scaffold(path):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        scope = Scope(source, source.module_of(path), tree)
        lines = {node.lineno for node in ast.walk(tree)
                 if isinstance(node, (ast.Name, ast.Attribute)) and scope.resolve(node) == target}
        lines |= {node.lineno for node in ast.walk(tree)
                  if isinstance(node, ast.Constant) and _is_dotted_path(node.value)
                  and (split := source.dotted(node.value)) is not None and source.attribute(*split) == target}
        for call, _ in replacement_calls(tree):
            found = replacement_of(scope, call)
            if found is not None and found.owner is not None and found.name is not None \
                    and source.attribute(found.owner, found.name) == target:
                lines.add(call.lineno)
        out += [f"{path.relative_to(root).as_posix()}:{line}" for line in sorted(lines)]
    return out


def test_tests_do_not_touch_the_tuning_values_in_effect() -> None:
    violations = tuning_values_touched(BACKEND_ROOT)

    assert violations == [], (
        "較正値の置き場（`TUNING_VALUES`）に触れているテストがある。テストの較正値から入力を組み、読むときは`tuning_value`で"
        "読むこと（.claude/rules/testing.md「確かめる高さ」）:\n  " + "\n  ".join(violations)
    )


def test_detects_the_tuning_values_written_in_any_form_but_not_in_the_scaffold(tmp_path: Path) -> None:
    """検査が効いていること。落とす側は、取り込んだ名前への書き込み・モジュール越しの属性・道筋の文字列・持ち主と名前の文字列の
    差し替え。落とさない側は、読み口の関数と、足場の書き込み。"""
    root = write_files(tmp_path, {
        "app/__init__.py": "",
        "app/domain/__init__.py": "",
        "app/domain/tuning.py": "TUNING_VALUES = {}\n\n\ndef tuning_value(key):\n    return TUNING_VALUES[key]\n",
        "tests/__init__.py": "",
        "tests/conftest.py": "from app.domain.tuning import TUNING_VALUES\n\nTUNING_VALUES.update({'a': 1.0})\n",
        "tests/test_sample.py": (
            "from unittest.mock import patch\n"
            "from app.domain import tuning\nfrom app.domain.tuning import TUNING_VALUES, tuning_value\n\n\n"
            "def test_x(monkeypatch):\n"
            "    monkeypatch.setitem(TUNING_VALUES, 'a', 2.0)\n"
            "    tuning.TUNING_VALUES['a'] = 2.0\n"
            "    with patch.dict('app.domain.tuning.TUNING_VALUES', {'a': 2.0}):\n"
            "        monkeypatch.setattr(tuning, 'TUNING_VALUES', {})\n"
            "    assert tuning_value('a') == 1.0\n"
        ),
    })

    assert tuning_values_touched(root) == [
        "tests/test_sample.py:7",
        "tests/test_sample.py:8",
        "tests/test_sample.py:9",
        "tests/test_sample.py:10",
    ]
