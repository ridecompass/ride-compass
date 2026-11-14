"""検査と道具が共有する、リポジトリのファイルの母集団と読み方。

置き場と名前の取り方の宣言は`scripts/repo_population.json`が持ち、frontend の道具（`frontend/scripts/structure-population.mjs`）も
同じファイルを読む。ここは Python の読み手へ、その宣言と、実在の母集団・読み方・例の形・人が読む文の範囲を渡す。

宣言の鍵:
  - `unmaintained`: 記録。**維持しない**（`docs/records/README.md`）。記録時点で嘘が無ければよく、後から実装と食い違っても
    欠陥ではないので、整合を求める対象にしない。実在はするので、実在の母集団には入れる。
  - `scaffold`: テストのファイル名を持たないテストの足場の置き場（`/tests/`・`/test/`の外にあるもの）。
  - `generated`: backend の宣言から作る生成物の置き場。`generatedWithoutNames`はそのうち API の型のファイルで、宣言の値を持たない。
  - `nameKey`・`nameMinLength`・`japanese`: 生成物が名前として配る値（鍵が`nameKey`の日本語の値）の取り方。短い値は
    「風」「時間」のような一般語と区別できないので、`nameMinLength`字に満たない値は名前に数えない。
"""

from __future__ import annotations

import ast
import io
import json
import re
import tokenize
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


# --- 人が読む文の範囲（文書の全文と、ソースのコメント・docstring） ---------------------------------------------

_HASH_COMMENT_SUFFIXES = frozenset({".yml", ".yaml", ".sh", ".ini", ".toml"})
_SLASH_COMMENT_SUFFIXES = frozenset({".ts", ".tsx", ".js", ".mjs", ".cjs", ".css"})
#: 人が読む文の範囲を切り出せるファイルの拡張子。
_PROSE_SUFFIXES = frozenset({".md", ".py", ".sql"}) | _HASH_COMMENT_SUFFIXES | _SLASH_COMMENT_SUFFIXES


def is_maintained_prose(rel_path: str) -> bool:
    """維持する対象のうち、人が読む文の範囲を切り出せるファイルか（記録は維持しないので外す）。"""
    return Path(rel_path).suffix in _PROSE_SUFFIXES and not rel_path.startswith(UNMAINTAINED_PREFIXES)


def _line_offsets(text: str) -> list[int]:
    offsets = [0]
    for line in text.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    return offsets


def _python_prose_spans(text: str) -> list[tuple[int, int]]:
    offsets = _line_offsets(text)

    def at(row: int, col: int) -> int:
        return offsets[row - 1] + col

    spans = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(text).readline):
            if tok.type == tokenize.COMMENT:
                spans.append((at(*tok.start), at(*tok.end)))
        tree = ast.parse(text)
    except (SyntaxError, tokenize.TokenError):
        return [(0, len(text))]
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
            and node.end_lineno is not None
            and node.end_col_offset is not None
        ):
            # ASTの列はUTF-8のバイト数なので、行の中の位置は文字数へ直す。
            start_line = text[offsets[node.lineno - 1] : offsets[node.lineno]].encode("utf-8")
            end_line = text[offsets[node.end_lineno - 1] : offsets[node.end_lineno]].encode("utf-8")
            start_col = len(start_line[: node.col_offset].decode("utf-8"))
            end_col = len(end_line[: node.end_col_offset].decode("utf-8"))
            spans.append((at(node.lineno, start_col), at(node.end_lineno, end_col)))
    return spans


def _slash_prose_spans(text: str) -> list[tuple[int, int]]:
    """`//`・`/* */`のコメント。文字列（'・"・`）の中の記号はコメントの始まりに数えない。"""
    spans = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in "'\"`":
            j = i + 1
            while j < n and text[j] != c:
                if text[j] == "\\":
                    j += 1
                elif text[j] == "\n" and c != "`":
                    break
                j += 1
            i = j + 1
        elif text.startswith("//", i):
            end = text.find("\n", i)
            end = n if end < 0 else end
            spans.append((i, end))
            i = end
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            end = n if end < 0 else end + 2
            spans.append((i, end))
            i = end
        else:
            i += 1
    return spans


def _line_comment_spans(text: str, marker: str) -> list[tuple[int, int]]:
    pattern = re.compile(r"(?:^|(?<=\s))" + re.escape(marker) + r"[^\n]*", re.MULTILINE)
    return [m.span() for m in pattern.finditer(text)]


def _prose_spans(rel_path: str, text: str) -> list[tuple[int, int]]:
    """そのファイルのうち、人が読む文として書かれた範囲（Markdownは全文、ソースはコメントとdocstring）。"""
    suffix = Path(rel_path).suffix
    if suffix == ".md":
        return [(0, len(text))]
    if suffix == ".py":
        return _python_prose_spans(text)
    if suffix in _SLASH_COMMENT_SUFFIXES:
        return _slash_prose_spans(text)
    if suffix in _HASH_COMMENT_SUFFIXES:
        return _line_comment_spans(text, "#")
    if suffix == ".sql":
        return _line_comment_spans(text, "--")
    return []


_BLANKED = re.compile(r"[^\n]")


def _keep(text: str, spans: list[tuple[int, int]], *, inside: bool) -> str:
    """spansの内側（inside=True）か外側だけを残し、残りは改行を保って空白にする（位置と行番号を保つ）。"""
    pieces: list[str] = []
    at = 0
    for start, end in sorted(spans):
        start = max(start, at)
        if start >= end:
            continue
        pieces += [text[at:start], text[start:end]]
        at = end
    pieces.append(text[at:])
    blank = 0 if inside else 1
    return "".join(_BLANKED.sub(" ", piece) if k % 2 == blank else piece for k, piece in enumerate(pieces))


def prose_text(rel_path: str, text: str) -> str:
    """人が読む文の範囲だけを残したテキスト（ほかは改行を保って空白にするので、位置と行番号は元のまま）。"""
    return _keep(text, _prose_spans(rel_path, text), inside=True)


def code_text(rel_path: str, text: str) -> str:
    """人が読む文の範囲を空白にしたテキスト（コードだけ。位置と行番号は元のまま）。"""
    return _keep(text, _prose_spans(rel_path, text), inside=False)
