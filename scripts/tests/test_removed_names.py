"""`scripts/removed_names.py`の、消えた名前の取り方と、それを書いた文・開いた issue の探し方のテスト。

一時ディレクトリに作った小さなリポジトリで、名前を消すコミットを作って確かめる。
"""

import textwrap
from pathlib import Path

from git_repo import git
from script_module import load_script

rn = load_script("removed_names")


def _write(root: Path, files: dict[str, str]) -> None:
    for relative, text in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(text), encoding="utf-8")


def _repository(root: Path) -> None:
    git(root, "init", "-q", "-b", "master")
    _write(root, {
        "app/kept.py": """\
            def kept_name():
                pass


            def gone_name():
                pass
        """,
        "app/old_module.py": "OLD_VALUE = 1\n",
        "app/caller.py": '# gone_name を呼ぶ\nLABEL = "kept_name"\n',
        "app/table.ts": "export const GoneTable = 1;\n",
        "docs/guide.md": "`gone_name`・`kept_name`・`old_module.py`・`old_module`・`GoneTable`・events。\n",
        "docs/records/old.md": "`gone_name`\n",
    })
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "前")


def test_finds_prose_naming_what_the_range_removed(tmp_path):
    """範囲で消えた定義名と消えたファイルの名前を、維持する文書とコメントから拾う。今もコードにある名前・記録・1語の名前は拾わない。"""
    _repository(tmp_path)
    _write(tmp_path, {"app/kept.py": "def kept_name():\n    pass\n"})
    (tmp_path / "app/old_module.py").unlink()
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-q", "-m", "消す")

    names = rn.removed_names(tmp_path, "HEAD^..HEAD")

    assert names == {"gone_name", "old_module", "old_module.py", "OLD_VALUE"}
    assert rn.prose_hits(tmp_path, names) == [
        "app/caller.py:1: gone_name",
        "docs/guide.md:1: gone_name",
        "docs/guide.md:1: old_module.py",
        "docs/guide.md:1: old_module",
    ]


def test_counts_uncommitted_removals_from_the_merge_base(tmp_path):
    """範囲を省くと、origin の master との合流点から、まだコミットしていない変更までを見る。"""
    _repository(tmp_path)
    git(tmp_path, "update-ref", "refs/remotes/origin/master", "HEAD")
    _write(tmp_path, {"app/table.ts": "export const KeptTable = 1;\n"})

    assert rn.removed_names(tmp_path, None) == {"GoneTable"}


def test_finds_open_issues_naming_removed_names():
    """題名と本文から、名前の一部でなく名前そのものとして書いた所を拾う。"""
    issues = [
        {"number": 1, "title": "gone_name を直す", "body": "`old_module.py` を読む"},
        {"number": 2, "title": "別の件", "body": "gone_name_v2 と sub.gone_name"},
        {"number": 3, "title": "本文なし", "body": None},
    ]

    assert rn.issue_hits({"gone_name", "old_module.py"}, issues) == [
        "#1 gone_name を直す: gone_name",
        "#1 gone_name を直す: old_module.py",
    ]
