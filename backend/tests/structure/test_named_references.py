"""文書とコメントが名指ししたもの（「パス: 名前」・ファイルのパス・APIのパス）が、今のリポジトリに実在することの検査。

名指しした名前が消えても・動いても、書いた側は何も壊れない。読んだ人は無い関数・ファイル・APIを探して迷う。
何を読み、何を実在とみなすかの規約は`.claude/rules/documentation.md`「他のファイルの名前は
「パス: 名前」で指す」が持つ。ここでは見ないもの: 形を外れた名指し（「`page.tsx`の`X`」・最上位の
ディレクトリから書いていない、テストでないファイルのパス等）は周期レビューの「名指しの実在」が見る。
"""

from __future__ import annotations

import re
import subprocess
from collections.abc import Iterator
from functools import cache
from pathlib import Path

# 実在の母集団・維持する文の範囲・例の形は、文書のリンクの検査（`scripts/review_checks.py`）と同じ口から取る。
from repo_population import EXAMPLE, code_text, is_maintained_prose, prose_text, read_text, repository_files

from tests.structure.source_symbols import write_files

REPO_ROOT = Path(__file__).resolve().parents[3]

TARGET_EXTENSIONS = r"(?:py|tsx?|js|mjs|cjs|ya?ml|json|sql|sh|toml|ini|css)"

# コロンの後は空白1つ以上か改行（行を折り返した先の行頭のコメント記号は読み飛ばす）。
# `host.json:ro`のようにコロンの直後に続く綴りは名指しではない。
REFERENCE = re.compile(
    r"(?<![A-Za-z0-9_./*-])"
    r"(?P<path>[A-Za-z0-9_.*/-]*[A-Za-z0-9_*-]\." + TARGET_EXTENSIONS + r")"
    r"`?:(?:[ \t]+|[ \t]*\n[ \t]*(?:#|//|\*|>)?[ \t]*)`?"
    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)"
)

# ファイルのパスとして読むのは、テストのファイル名と、リポジトリの最上位のディレクトリから書いたパスだけ。
# ほかの拡張子つきの綴り（外部の配信のファイル名・ライブラリの名前）は、消えたファイルの名指しと書いた位置で
# 見分けられない。`<…>`・`{…}`を含む綴りは例の形なので、綴りごと読まない。
PATH = re.compile(
    r"(?<![A-Za-z0-9_./*:<>{}\[\]-])"
    r"(?P<path>[A-Za-z0-9_.*/\[\]-]*[A-Za-z0-9_*\]-]\.[A-Za-z0-9]+)"
    r"(?![A-Za-z0-9_/<>{}])"
)
TEST_FILE = re.compile(r"(?:^|/)(?:test_[^/]*\.py|[^/]*\.test\.tsx?)$")

# `<…>`・`{…}`はその位置に何かが入る例として読む（`/api/admin<X>`・`/api/admin/<X>`）。
API_PATH = re.compile(rf"(?<![A-Za-z0-9_./:<>{{}}-])(?P<path>/api/(?:{EXAMPLE.pattern}|[A-Za-z0-9_.{{}}*/-])*)")
ROUTE_HANDLER = re.compile(r"^frontend/src/app/(?P<path>.*)/route\.ts$")


class _Repository:
    def __init__(self, root: Path, files: list[str]) -> None:
        self.root = root
        self.files = files
        self._by_name: dict[str, list[str]] = {}
        for f in files:
            self._by_name.setdefault(Path(f).name, []).append(f)
        self._code: dict[str, str] = {}

    def text(self, rel_path: str) -> str:
        return read_text(self.root / rel_path)

    def resolve(self, written: str) -> list[str]:
        written = re.sub(r"^(?:\.\.?/)+", "", written)
        if "*" in written:
            pattern = re.compile(r"^(?:.*/)?" + re.escape(written).replace(r"\*", "[^/]*") + "$")
            return [f for f in self.files if pattern.match(f)]
        return [f for f in self._by_name.get(Path(written).name, []) if f == written or f.endswith("/" + written)]

    def code(self, rel_path: str) -> str:
        if rel_path not in self._code:
            self._code[rel_path] = code_text(rel_path, self.text(rel_path))
        return self._code[rel_path]


def _names_in(code: str, dotted: str) -> bool:
    return all(
        re.search(r"(?<![A-Za-z0-9_$])" + re.escape(part) + r"(?![A-Za-z0-9_$])", code) for part in dotted.split(".")
    )


@cache
def _prose(root: Path, rel_path: str) -> str:
    """人が読む文の範囲だけを残したテキスト。本物のリポジトリを読む3つの検査が1回の抜き出しを共有する。"""
    return prose_text(rel_path, read_text(root / rel_path))


def _prose_files(repo: _Repository) -> Iterator[tuple[str, str]]:
    """維持するファイルごとの、人が読む文の範囲だけを残したテキスト。"""
    for rel_path in repo.files:
        if not is_maintained_prose(rel_path):
            continue
        yield rel_path, _prose(repo.root, rel_path)


def _line_of(prose: str, match: re.Match[str]) -> int:
    return prose.count("\n", 0, match.start()) + 1


def dangling_references(root: Path, files: list[str]) -> list[str]:
    """「パス: 名前」の名指しのうち、実在しないものを`書いた場所: 名指し（理由）`で返す。"""
    repo = _Repository(root, files)
    found = []
    for rel_path, prose in _prose_files(repo):
        for m in REFERENCE.finditer(prose):
            written, name = m.group("path"), m.group("name")
            where = f"{rel_path}:{_line_of(prose, m)}: {written}: {name}"
            candidates = repo.resolve(written)
            if not candidates:
                found.append(f"{where}（そのパスのファイルが無い）")
            elif len(candidates) > 1 and "*" not in written:
                found.append(f"{where}（パスが{len(candidates)}本に当たる。親ディレクトリを足して1本に決める）")
            elif not any(_names_in(repo.code(c), name) for c in candidates):
                found.append(f"{where}（そのファイルのコードに名前が無い）")
    return found


def _ignored(root: Path, paths: set[str]) -> set[str]:
    """`.gitignore`が無視するパス。開発機にだけ置くファイル（`.env`等）は、リポジトリがその置き場を宣言している。"""
    out = subprocess.run(
        ["git", "check-ignore", "--no-index", "--stdin", "-z"],
        cwd=root,
        input="\0".join(sorted(paths)).encode("utf-8"),
        capture_output=True,
    )
    # 終了コード1は「どれも無視されない」。
    if out.returncode not in (0, 1):
        raise RuntimeError(out.stderr.decode("utf-8"))
    return {p for p in out.stdout.decode("utf-8").split("\0") if p}


def dangling_paths(root: Path, files: list[str]) -> list[str]:
    """名指ししたファイルのパスのうち、実在しないものを`書いた場所: パス（理由）`で返す。"""
    repo = _Repository(root, files)
    top_dirs = {f.split("/", 1)[0] for f in files if "/" in f}
    unresolved = []
    for rel_path, prose in _prose_files(repo):
        for m in PATH.finditer(prose):
            written = m.group("path")
            if not (TEST_FILE.search(written) or ("/" in written and written.split("/", 1)[0] in top_dirs)):
                continue
            if not repo.resolve(written):
                unresolved.append((f"{rel_path}:{_line_of(prose, m)}: {written}", written))
    ignored = _ignored(root, {written for _, written in unresolved})
    return [f"{where}（そのパスのファイルが無い）" for where, written in unresolved if written not in ignored]


def _route_template(rel_path: str) -> str | None:
    """Nextのroute handlerのファイルが受けるURLのパス（`[x]`・`[...x]`は`{x}`、`(group)`は外す）。"""
    m = ROUTE_HANDLER.match(rel_path)
    if not m:
        return None
    segments = [s for s in m.group("path").split("/") if not (s.startswith("(") and s.endswith(")"))]
    return "/" + "/".join(re.sub(r"^\[(?:\.\.\.)?(.*)\]$", r"{\1}", s) for s in segments)


def _api_exists(written: str, routes: list[str]) -> bool:
    """書いたパスが、あるAPIのパスそのものか、その先頭の区切り（`/api/admin`）か。"""
    written = written.rstrip("./")
    pattern = re.escape(written)
    pattern = EXAMPLE.sub(".*", pattern)
    pattern = re.sub(r"\\\{[^/]*?\\\}", "[^/]*", pattern)
    pattern = pattern.replace(r"\*\*", ".*").replace(r"\*", "[^/]*")
    for route in routes:
        if re.match("^" + pattern + "(?:/|$)", route):
            return True
        concrete = re.sub(r"\\\{path\\\}", ".+", re.escape(route))
        if re.fullmatch(re.sub(r"\\\{[^/]*?\\\}", "[^/]+", concrete), written):
            return True
    return False


def dangling_api_paths(root: Path, files: list[str], api_paths: list[str]) -> list[str]:
    """名指ししたAPIのパス（`/api/…`）のうち、backendのAPIのパス（`api_paths`）にもNextのroute handlerにも無いものを返す。"""
    repo = _Repository(root, files)
    routes = api_paths + [t for t in map(_route_template, files) if t and t.startswith("/api/")]
    found = []
    for rel_path, prose in _prose_files(repo):
        for m in API_PATH.finditer(prose):
            if not _api_exists(m.group("path"), routes):
                found.append(f"{rel_path}:{_line_of(prose, m)}: {m.group('path')}（そのパスのAPIが無い）")
    return found


#: タスクの番号。経緯はタスクの issue に書き、維持する文書とコメントには書かない（docs/modules/README.md「記載粒度」・
#: .claude/rules/comments.md の経緯）。例は`tasks#<番号>`の形で書く。
TASK_NUMBER = re.compile(r"(?<![A-Za-z0-9_])tasks#\d+")


def task_numbers(root: Path, files: list[str]) -> list[str]:
    """維持する文書とコメントに書いたタスクの番号を`書いた場所: 番号`で返す。"""
    repo = _Repository(root, files)
    return [
        f"{rel_path}:{_line_of(prose, m)}: {m.group()}"
        for rel_path, prose in _prose_files(repo)
        for m in TASK_NUMBER.finditer(prose)
    ]


def test_named_references_exist() -> None:
    dangling = dangling_references(REPO_ROOT, repository_files(REPO_ROOT))

    assert dangling == [], (
        "文書・コメントが「パス: 名前」で名指ししたものが見つからない。今の名前・パスへ直すか、"
        "名前を出さずに挙動を書く:\n  " + "\n  ".join(dangling)
    )


def test_named_paths_exist() -> None:
    dangling = dangling_paths(REPO_ROOT, repository_files(REPO_ROOT))

    assert dangling == [], (
        "文書・コメントが名指ししたファイルが見つからない。今のパスへ直すか、例なら`<…>`の形で書く:\n  "
        + "\n  ".join(dangling)
    )


def test_named_api_paths_exist() -> None:
    from app.main import app

    dangling = dangling_api_paths(REPO_ROOT, repository_files(REPO_ROOT), list(app.openapi()["paths"]))

    assert dangling == [], (
        "文書・コメントが名指ししたAPIのパスが見つからない。今のパスへ直すか、例なら`<…>`の形で書く:\n  "
        + "\n  ".join(dangling)
    )


def test_no_task_numbers_in_maintained_prose() -> None:
    found = task_numbers(REPO_ROOT, repository_files(REPO_ROOT))

    assert found == [], (
        "維持する文書とコメントにタスクの番号がある。経緯はタスクの issue へ移し、例なら`tasks#<番号>`の形で書く:\n  "
        + "\n  ".join(found)
    )


def test_detects_task_numbers(tmp_path: Path) -> None:
    """文書とコメントの番号を捕まえ、例の形・文字列リテラル・記録は見逃す。"""
    files = {
        "app/a.py": '# tasks#12 で足した\nTITLE = "tasks#34: 題"\n',
        "app/b.ts": "// 件名は `tasks#<番号>:`\n",
        "docs/guide.md": "経緯は tasks#56 にある。\n",
        "docs/records/old.md": "tasks#78\n",
    }
    write_files(tmp_path, files)

    assert task_numbers(tmp_path, sorted(files)) == [
        "app/a.py:1: tasks#12",
        "docs/guide.md:1: tasks#56",
    ]


def test_detects_dangling_references(tmp_path: Path) -> None:
    """検査が効いていること（消えた名前・無いパス・曖昧なパスを、対象ファイル表の行の中でも置いて捕まえ、
    正しい名指しと文字列リテラルは見逃す）。"""
    files = {
        "app/a.py": '"""モジュール。"""\n\nLIVE = 1\n# GONE はコメントにだけ残っている\n',
        "app/b/util.ts": "export const helper = 1;\n",
        "app/c/util.ts": "export const helper = 2;\n",
        "app/d.py": (
            "# `a.py: LIVE`は実在する。`a.py: GONE`はコードに無い。\n"
            'MESSAGE = "a.py: NOT_A_REFERENCE"\n'
            "# 折り返した名指しも読む: a.py:\n"
            "# GONE_TOO\n"
        ),
        "app/e.ts": '// `a.py: GONE_TS`\nconst url = "https://x/a.py: NOT_A_REFERENCE";\n',
        "docs/guide.md": "`util.ts: helper`と`b/util.ts: helper`と`missing.py: X`。\n",
        "docs/modules/table.md": "| domain | `a.py`（`a.py: LIVE`と`a.py: GONE_ROW`） |\n",
        "docs/records/old.md": "`a.py: GONE`\n",
    }
    write_files(tmp_path, files)

    assert dangling_references(tmp_path, sorted(files)) == [
        "app/d.py:1: a.py: GONE（そのファイルのコードに名前が無い）",
        "app/d.py:3: a.py: GONE_TOO（そのファイルのコードに名前が無い）",
        "app/e.ts:1: a.py: GONE_TS（そのファイルのコードに名前が無い）",
        "docs/guide.md:1: util.ts: helper（パスが2本に当たる。親ディレクトリを足して1本に決める）",
        "docs/guide.md:1: missing.py: X（そのパスのファイルが無い）",
        "docs/modules/table.md:1: a.py: GONE_ROW（そのファイルのコードに名前が無い）",
    ]


def test_untracked_files_count_as_existing(tmp_path: Path) -> None:
    """`git add`前の新しいファイルは実在に数え、無視されたファイルは数えない。"""
    files = _write_repository(tmp_path, {
        ".gitignore": "ignored.py\n",
        "app/new.py": "LIVE = 1\n",
        "app/ignored.py": "HIDDEN = 1\n",
        "docs/guide.md": "`new.py: LIVE`と`ignored.py: HIDDEN`。\n",
    })

    assert dangling_references(tmp_path, files) == [
        "docs/guide.md:1: ignored.py: HIDDEN（そのパスのファイルが無い）",
    ]


def _write_repository(root: Path, files: dict[str, str]) -> list[str]:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    return repository_files(write_files(root, files))


def test_detects_dangling_paths(tmp_path: Path) -> None:
    """テストのファイル名と最上位のディレクトリから書いたパスだけを読み、無いものを捕まえる。ほかの綴り・例の形・
    `.gitignore`が無視するファイル・文字列リテラルは見逃す。"""
    files = _write_repository(
        tmp_path,
        {
            ".gitignore": "*.local\n",
            ".claude/settings.json": "{}\n",
            "backend/app/a.py": '"""モジュール。"""\n',
            "backend/tests/test_a.py": "",
            "backend/app/b.py": 'PATH = "backend/app/gone.py"\n# 消えた`backend/app/gone_too.py`\n',
            "docs/guide.md": (
                "`backend/app/a.py`・`app/a.py`・`test_a.py`・`backend/tests/test_*.py`・`.claude/settings.json`・"
                "`../backend/app/a.py`・`backend/.env.local`・`backend/<名前>.py`・`area.json`・`https://x/backend/gone.py`。\n"
                "`backend/app/gone.py`・`test_gone.py`・`frontend/x.test.ts`。\n"
            ),
            "docs/records/old.md": "`backend/app/gone.py`\n",
        },
    )

    assert dangling_paths(tmp_path, files) == [
        "backend/app/b.py:2: backend/app/gone_too.py（そのパスのファイルが無い）",
        "docs/guide.md:2: backend/app/gone.py（そのパスのファイルが無い）",
        "docs/guide.md:2: test_gone.py（そのパスのファイルが無い）",
        "docs/guide.md:2: frontend/x.test.ts（そのパスのファイルが無い）",
    ]


def test_detects_dangling_api_paths(tmp_path: Path) -> None:
    """backendのOpenAPIとNextのroute handlerに照らし、無いAPIのパスを捕まえる。パスそのもの・先頭の区切り・
    埋めた値・例の形は見逃す。"""
    files = _write_repository(
        tmp_path,
        {
            "frontend/src/app/api/version/route.ts": "export const GET = 1;\n",
            "frontend/src/app/admin/api/[...path]/route.ts": "export const GET = 1;\n",
            "backend/app/c.py": 'URL = "/api/gone"\n',
            "docs/api.md": (
                "`GET /api/admin/items/{id}/values`・`/api/admin`・`/api/admin/`・`/api/admin<X>`・`/api/admin/*`・"
                "`/api/tiles/a/b.png`・`/api/version`・`/admin/api/x`・`https://x/api/gone`。\n"
                "`/api/items/{item_id}/values`・`/api/version/gone`・`/api/admi`。\n"
            ),
        },
    )

    assert dangling_api_paths(tmp_path, files, ["/api/admin/items/{item_id}/values", "/api/tiles/{path}"]) == [
        "docs/api.md:2: /api/items/{item_id}/values（そのパスのAPIが無い）",
        "docs/api.md:2: /api/version/gone（そのパスのAPIが無い）",
        "docs/api.md:2: /api/admi（そのパスのAPIが無い）",
    ]
