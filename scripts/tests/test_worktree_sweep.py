"""`scripts/worktree_sweep.py`のテスト。

origin は一時的な bare リポジトリで作り、git は本物を通す。マージ済みの PR の一覧（gh）だけは差し替える。

ここで見ないもの: フックからの結線（`--detach` が裏のプロセスを起こす所。`.claude/settings.json`）と、二重に走らない印。
"""

import os
import time
from pathlib import Path

import pytest
from git_repo import git
from script_module import load_script

ws = load_script("worktree_sweep")
OLD = time.time() - 10 * 24 * 3600


def _commit(repo: Path, name: str) -> str:
    (repo / name).write_text(name, encoding="utf-8")
    git(repo, "add", name)
    git(repo, "commit", "-q", "-m", name)
    return git(repo, "rev-parse", "HEAD")


def _idle(worktree: Path) -> None:
    """作業ツリーで git が動いた時刻（作業ツリーごとの HEAD と index）を古くする。"""
    admin = Path(git(worktree, "rev-parse", "--path-format=absolute", "--git-dir"))
    for name in ("HEAD", "index"):
        if (admin / name).exists():
            os.utime(admin / name, (OLD, OLD))


@pytest.fixture
def repo(tmp_path):
    """origin（bare）と、それを取った本体のチェックアウト。master に1つコミットがある。"""
    origin = tmp_path / "origin.git"
    git(tmp_path, "init", "-q", "--bare", "-b", "master", str(origin))
    main = tmp_path / "main"
    git(tmp_path, "clone", "-q", str(origin), str(main))
    _commit(main, "a")
    git(main, "push", "-q", "origin", "master")
    return main


def _add(repo: Path, name: str, *, branch: str | None = None, idle: bool = True) -> Path:
    path = repo.parent / name
    git(repo, "worktree", "add", "-q", *(["-b", branch] if branch else ["--detach"]), str(path), "origin/master")
    if idle:
        _idle(path)
    return path


def test_removes_reflected_idle_worktrees_and_keeps_work_in_progress(repo, monkeypatch):
    """反映済み（master に入った・マージ済みの PR の先頭に入った）で、変更が無く、git の操作が1日以上無い作業ツリーだけを消す。
    消すとブランチと登録も消える。変更のある・作ったばかりの・反映されていない・ロックされた・呼んだセッションの作業ツリーは残す。"""
    in_master = _add(repo, "in-master")
    dirty = _add(repo, "dirty")
    (dirty / "note.txt").write_text("書きかけ", encoding="utf-8")
    _add(repo, "fresh", idle=False)
    unmerged = _add(repo, "unmerged", branch="orch/tasks-2", idle=False)
    _commit(unmerged, "b")
    _idle(unmerged)
    merged = _add(repo, "merged", branch="orch/tasks-3", idle=False)
    merged_head = _commit(merged, "c")
    _idle(merged)
    locked = _add(repo, "locked")
    git(repo, "worktree", "lock", str(locked))
    protected = _add(repo, "protected")
    gone = _add(repo, "gone")
    ws.remove_tree(gone)
    monkeypatch.setattr(ws, "merged_pr_heads", lambda _repo: {"orch/tasks-3": [merged_head]})

    removed, kept = ws.sweep_worktrees(repo, [protected / "sub"], dry_run=False)

    assert sorted(line.split("（")[0] for line in removed) == sorted([
        f"作業ツリー {in_master}", f"作業ツリー {merged}", "指す先の無い登録 gone"])
    assert sorted(path.name for path in kept) == ["dirty", "fresh", "locked", "protected", "unmerged"]
    listed = git(repo, "worktree", "list", "--porcelain")
    assert all(f"worktree {path.as_posix()}" not in listed for path in (in_master, merged, gone))
    assert not in_master.exists() and not merged.exists()
    assert git(repo, "branch", "--list", "orch/tasks-3") == ""
    assert git(repo, "branch", "--list", "orch/tasks-2") != ""


def test_removes_only_old_scratch_that_no_session_still_uses(tmp_path):
    """中身が3日以上書き換えられていないスクラッチだけを消す。呼んだセッションのスクラッチと、残した作業ツリーを中に持つ
    スクラッチは、古くても残す。"""
    root = tmp_path / "claude"

    def scratch(session: str, *, old: bool) -> Path:
        path = root / "project" / session / "scratchpad"
        (path / "wt" / "src").mkdir(parents=True)
        (path / "wt" / "src" / "file.txt").write_text("x", encoding="utf-8")
        if old:
            for p in (path / "wt" / "src" / "file.txt", path / "wt" / "src", path / "wt", path):
                os.utime(p, (OLD, OLD))
        return path

    old = scratch("old", old=True)
    new = scratch("new", old=False)
    own = scratch("own", old=True)
    holding = scratch("holding", old=True)

    removed = ws.sweep_scratch(root, keep=[holding / "wt"], session_id="own", dry_run=False)

    assert [line.split("（")[0] for line in removed] == [f"スクラッチ {old}"]
    assert not old.exists() and new.exists() and own.exists() and holding.exists()
