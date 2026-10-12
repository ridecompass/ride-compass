"""検査と道具が共有する、リポジトリのファイルの母集団と読み方。

置き場と名前の取り方の宣言は`scripts/repo_population.json`が持ち、frontend の道具（`frontend/scripts/structure-population.mjs`）も
同じファイルを読む。ここは Python の読み手へ、その宣言と、実在の母集団・読み方・例の形を渡す。

宣言の鍵:
  - `unmaintained`: 記録。**維持しない**（`docs/records/README.md`）。記録時点で嘘が無ければよく、後から実装と食い違っても
    欠陥ではないので、整合を求める対象にしない。実在はするので、実在の母集団には入れる。
  - `scaffold`: テストのファイル名を持たないテストの足場の置き場（`/tests/`・`/test/`の外にあるもの）。
  - `generated`: backend の宣言から作る生成物の置き場。`generatedWithoutNames`はそのうち API の型のファイルで、宣言の値を持たない。
  - `nameKey`・`nameMinLength`・`japanese`: 生成物が名前として配る値（鍵が`nameKey`の日本語の値）の取り方。短い値は
    「風」「時間」のような一般語と区別できないので、`nameMinLength`字に満たない値は名前に数えない。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from repo_git import run

_DECLARED = json.loads(Path(__file__).with_suffix(".json").read_text(encoding="utf-8"))

UNMAINTAINED_PREFIXES: tuple[str, ...] = tuple(_DECLARED["unmaintained"])
SCAFFOLD_PREFIXES: tuple[str, ...] = tuple(_DECLARED["scaffold"])
GENERATED: str = _DECLARED["generated"]
GENERATED_PREFIXES: tuple[str, ...] = (GENERATED,)
GENERATED_WITHOUT_NAMES: frozenset[str] = frozenset(_DECLARED["generatedWithoutNames"])
NAME_KEY: str = _DECLARED["nameKey"]
NAME_MIN_LENGTH: int = _DECLARED["nameMinLength"]
JAPANESE = re.compile(_DECLARED["japanese"])

#: 例の形。その位置に何かが入ることを表し、実在しなくてよい（.claude/rules/documentation.md「他のファイルの名前は「パス: 名前」で指す」）。
EXAMPLE = re.compile(r"<[^<>\s]*>")


def repository_files(root: Path) -> list[str]:
    """実在の母集団: 追跡下のファイルと、まだ`git add`していない無視されていないファイル。

    文書が名指す・リンクする先の実在はこれで見る。手元で足したばかりのファイルも、コミットすれば実在するので数える。
    """
    out = run("ls-files", "-z", "--cached", "--others", "--exclude-standard", cwd=root, check=True).stdout
    return [f for f in out.split("\0") if f]


def read_text(path: Path) -> str:
    """UTF-8 の文として読む。読めないファイル（消えた・文でない）は空の文として扱う。"""
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""
