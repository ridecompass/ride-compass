"""Pull Request の差分で変わった行を含む `app` の関数を、mutmut の関数の名前（mangled name）で出す。backend の下で打つ。

引数: 比べる版（ふつうは master との合流点のコミット）
出すもの: 1行に1つ、mutmut の関数の名前。入れ子の関数の行が変わったら、それを囲むモジュールの直下の関数かメソッドを出す。
行を消しただけの所は、消した位置を含む関数を出す。
"""
import ast
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))

from repo_git import run

from _shared import def_lines, mangled_name

HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def changed_lines(base):
    """ファイル（backend からのパス）ごとの、今の版で変わった行（消しただけの所は、その位置の行）。"""
    out = run("diff", "-U0", "--no-color", base, "--", "app", check=True).stdout
    lines: dict[str, set[int]] = {}
    path = None
    for line in out.splitlines():
        if line.startswith("+++ "):
            path = line[6:] if line.startswith("+++ b/") else None
            if path is not None:
                path = path.removeprefix("backend/")
        elif path and path.endswith(".py"):
            m = HUNK.match(line)
            if m:
                start, count = int(m.group(1)), int(m.group(2) or "1")
                lines.setdefault(path, set()).update(range(start, start + max(count, 1)))
    return lines


def module_of(path):
    module = path[:-3].replace("/", ".")
    return module.removesuffix(".__init__")


def functions(path, lines):
    """そのファイルの、変わった行を含む関数の mutmut の名前。"""
    tree = ast.parse(open(path, encoding="utf-8").read())
    module = module_of(path)

    def span(node):
        start, end = def_lines(node)
        return set(range(start, end + 1))

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and span(node) & lines:
            yield mangled_name(module, node.name)
        elif isinstance(node, ast.ClassDef):
            for child in node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and span(child) & lines:
                    yield mangled_name(module, child.name, node.name)


def main():
    found = set()
    for path, lines in changed_lines(sys.argv[1]).items():
        try:
            found.update(functions(path, lines))
        except FileNotFoundError:
            continue  # ファイルごと消した
    for name in sorted(found):
        print(name)


if __name__ == "__main__":
    main()
