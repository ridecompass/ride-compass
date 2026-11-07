"""範囲で消えた名前を、今の維持する対象の人が読む文と、置き場の開いた issue から探す。

撤去のあとに、消えた名前を今のもののように名指す文が残るのを見つける。消えた名前は次の2つで、今の作業ツリーに無いものに限る。
  - 範囲の各コミットの削除行にある定義名（`DEFINITIONS`の形の複合の名前。今の作業ツリーのコードの字句に無いもの）
  - 範囲で消えた・改名されたファイルの前の名前と、拡張子を除いた複合の名前（今の作業ツリーのファイル名とコードの字句に無いもの）
探す先は、維持する対象（`repo_population.py: is_maintained_prose`）の人が読む文と、置き場の開いた issue の題名と本文。
出すのは候補で、断りつきで経緯を書いた文と、たまたま同じ綴りの外の名前は、読んで外す。

使い方: python scripts/removed_names.py [<範囲>] [--no-issues]
  範囲（`A..B`）を省くと、origin の master との合流点から今の作業ツリーまで（まだコミットしていない変更を含む）。
  開いた issue は`gh issue list`を1回打って読む。担当は置き場を読めるよう`GH_TOKEN=$FLOW_BOT_TOKEN`を付ける。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from repo_git import merge_base, run
from repo_population import (
    code_text,
    is_maintained_prose,
    prose_text,
    read_text,
    repository_files,
)

ROOT = Path(__file__).resolve().parents[1]
TASKS_REPO = "ridecompass/ride-compass-tasks"

_PY = {".py"}
_TS = {".ts", ".tsx", ".js", ".mjs", ".cjs"}
_NAME = r"([A-Za-z_$][A-Za-z0-9_$]*)"
#: 拡張子ごとの定義の形。字下げした`名前: 型`は、クラスの欄・引数・interface の欄（消えると名指しが残りやすいが、定義名ではない）。
DEFINITIONS: dict[frozenset[str], tuple[re.Pattern[str], ...]] = {
    frozenset(_PY): (
        re.compile(rf"^\s*(?:async\s+)?def\s+{_NAME}"),
        re.compile(rf"^\s*class\s+{_NAME}"),
        re.compile(rf"^{_NAME}\s*(?::[^=]+)?=(?!=)"),
        re.compile(rf"^\s+{_NAME}\s*:\s*[A-Za-z_\[\"'(]"),
    ),
    frozenset(_TS): (
        re.compile(rf"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+{_NAME}"),
        re.compile(rf"^\s*(?:export\s+)?(?:abstract\s+)?class\s+{_NAME}"),
        re.compile(rf"^\s*(?:export\s+)?(?:const|let|var)\s+{_NAME}"),
        re.compile(rf"^\s*(?:export\s+)?(?:declare\s+)?(?:type|interface|enum)\s+{_NAME}"),
        re.compile(rf"^\s+(?:readonly\s+)?{_NAME}\??\s*:\s*[A-Za-z_\[\"'({{]"),
    ),
}
#: 名前に数えるのは、下線か小文字から大文字への境を持つ複合の名前だけ（`events`・`catch`のような1語は、文の中の一般の語と
#: 見分けられない）。
COMPOUND = re.compile(r"[A-Za-z0-9]_[A-Za-z0-9]|[a-z0-9][A-Z]")
_TOKEN = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")


def _patterns(rel_path: str) -> tuple[re.Pattern[str], ...]:
    suffix = Path(rel_path).suffix
    return next((patterns for suffixes, patterns in DEFINITIONS.items() if suffix in suffixes), ())


def _defined(rel_path: str, lines: list[str]) -> set[str]:
    patterns = _patterns(rel_path)
    return {m.group(1) for line in lines for p in patterns if (m := p.match(line)) and COMPOUND.search(m.group(1))}


def _tokens_in_code(root: Path, files: list[str]) -> set[str]:
    """今の作業ツリーのコード（人が読む文を除く）に現れる字句。定義・引数・import・モジュールの名前を含む。"""
    tokens: set[str] = set()
    for rel_path in files:
        if is_maintained_prose(rel_path) and not rel_path.endswith(".md"):
            tokens |= set(_TOKEN.findall(code_text(rel_path, read_text(root / rel_path))))
    return tokens


_FILE_HEADER = re.compile(r"^diff --git a/(.+?) b/")


def _removed_lines(patch: str) -> dict[str, list[str]]:
    """差分の削除行を、前の版のファイルごとに。ファイルの見出し（`diff --git`から最初の`@@`まで）は読まない
    （消した行が`-- `で始まるSQLのコメントなら、削除行も`--- `で始まる）。"""
    by_file: dict[str, list[str]] = {}
    current, in_header = None, False
    for line in patch.splitlines():
        if m := _FILE_HEADER.match(line):
            current, in_header = m.group(1), True
        elif line.startswith("@@"):
            in_header = False
        elif not in_header and current is not None and line.startswith("-"):
            by_file.setdefault(current, []).append(line[1:])
    return by_file


def _gone_files(name_status: str) -> set[str]:
    """消えた・改名されたファイルの前のパス（`git ... --name-status --diff-filter=DR`の出力から）。"""
    gone = set()
    for line in name_status.splitlines():
        fields = line.split("\t")
        if len(fields) >= 2 and fields[0][:1] in "DR":
            gone.add(fields[1])
    return gone


def removed_names(root: Path, rev_range: str | None) -> set[str]:
    """範囲で消えた定義名とファイルの名前のうち、今の作業ツリーに無いもの。"""
    if rev_range is None:
        commits = f"{merge_base(cwd=root)}..HEAD"
        patches = [run("log", "-p", "-U0", "--format=", commits, cwd=root, check=True).stdout,
                   run("diff", "-U0", "HEAD", cwd=root, check=True).stdout]
        statuses = [run("log", "--format=", "--name-status", "--diff-filter=DR", commits, cwd=root, check=True).stdout,
                    run("diff", "--name-status", "--diff-filter=DR", "HEAD", cwd=root, check=True).stdout]
    else:
        patches = [run("log", "-p", "-U0", "--format=", rev_range, cwd=root, check=True).stdout]
        statuses = [run("log", "--format=", "--name-status", "--diff-filter=DR", rev_range, cwd=root, check=True).stdout]

    removed = set()
    for patch in patches:
        for rel_path, lines in _removed_lines(patch).items():
            removed |= _defined(rel_path, lines)
    files = repository_files(root)
    alive = _tokens_in_code(root, files) | {Path(f).name for f in files} | {Path(f).stem for f in files}
    for gone in set().union(*map(_gone_files, statuses)):
        removed.add(Path(gone).name)
        if COMPOUND.search(Path(gone).stem):
            removed.add(Path(gone).stem)
    return removed - alive


def _word(names: set[str]) -> re.Pattern[str]:
    alternatives = "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True))
    return re.compile(rf"(?<![A-Za-z0-9_$.])(?:{alternatives})(?![A-Za-z0-9_$])")


def prose_hits(root: Path, names: set[str]) -> list[str]:
    """維持する対象の人が読む文が、消えた名前を書いた所（`パス:行: 名前`）。"""
    if not names:
        return []
    word = _word(names)
    hits = []
    for rel_path in repository_files(root):
        if not is_maintained_prose(rel_path):
            continue
        prose = prose_text(rel_path, read_text(root / rel_path))
        for m in word.finditer(prose):
            hits.append(f"{rel_path}:{prose.count(chr(10), 0, m.start()) + 1}: {m.group()}")
    return hits


def issue_hits(names: set[str], issues: list[dict]) -> list[str]:
    """開いた issue の題名・本文が、消えた名前を書いた所（`#番号 題名: 名前`）。"""
    if not names:
        return []
    word = _word(names)
    hits = []
    for issue in issues:
        found = sorted(set(word.findall(f"{issue['title']}\n{issue.get('body') or ''}")))
        hits += [f"#{issue['number']} {issue['title']}: {name}" for name in found]
    return hits


def _open_issues() -> list[dict]:
    out = subprocess.run(
        ["gh", "issue", "list", "-R", TASKS_REPO, "--state", "open", "--limit", "1000", "--json", "number,title,body"],
        capture_output=True, text=True, encoding="utf-8", check=True,
    ).stdout
    return json.loads(out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("range", nargs="?", help="範囲（A..B）。省くと origin の master との合流点から今の作業ツリーまで")
    parser.add_argument("--no-issues", action="store_true", help="置き場の開いた issue を読まない")
    args = parser.parse_args(argv)

    names = removed_names(ROOT, args.range)
    print(f"## 消えた名前: {len(names)}件")
    print("## 維持する対象の文に残る名前（今のものとして名指していれば直す）")
    print("\n".join(prose_hits(ROOT, names)) or "なし")
    if not args.no_issues:
        print("## 開いた issue に残る名前（前提に書いていれば、その issue へ知らせる）")
        print("\n".join(issue_hits(names, _open_issues())) or "なし")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
