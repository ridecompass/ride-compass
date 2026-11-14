"""開発機のセッションが残した作業ツリーとスクラッチを片付ける。

セッションは作業ブランチごとに作業ツリーを作り（作業ツリーごとに node_modules を入れる）、スクラッチに作業ツリーの写しや
テストの足場を置く。PR のマージやセッションの終わりのあとに消す者がいないと、ディスクを使い切る。セッションの始まりの
フック（`.claude/settings.json`）が裏で打つ。

    python scripts/worktree_sweep.py            # 片付けて、消したものを出す
    python scripts/worktree_sweep.py --dry-run  # 消すものを出すだけ
    python scripts/worktree_sweep.py --detach   # フック用。標準入力のフックの JSON を読み、裏で片付けて、すぐ戻る

消すもの（どれも、動いているセッションの作業中のものを消さない条件と組にしている）:
- 本体を除く登録された作業ツリーで、書きかけの変更（追跡外のファイルを含む）が無く、ロックされておらず、git の操作が
  `WORKTREE_IDLE_SECONDS` 以上無く、HEAD が origin/master か、同じブランチのマージ済みの PR の先頭に入っているもの。
  呼んだセッションの作業ディレクトリと、この道具のチェックアウトがある作業ツリーは消さない。
- 指す先の無い作業ツリーの登録。
- 中身が `SCRATCH_IDLE_SECONDS` 以上書き換えられていないスクラッチ（`<一時フォルダ>/claude/<プロジェクト>/<セッション>/scratchpad`）。
  呼んだセッションのスクラッチと、消さずに残した作業ツリーを中に持つスクラッチは消さない。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import NamedTuple

from repo_git import UPSTREAM, run

REPO_ROOT = Path(__file__).resolve().parent.parent
#: git の操作がこれだけ無い作業ツリーだけを消す（作ったばかりで、まだ何もしていないセッションの作業ツリーを消さない）。
WORKTREE_IDLE_SECONDS = 24 * 3600
#: 中身がこれだけ書き換えられていないスクラッチを消す。
SCRATCH_IDLE_SECONDS = 3 * 24 * 3600
#: 片付けが走っている印。これより古い印は、落ちた片付けの残りとみなして取り直す。
LOCK_STALE_SECONDS = 3600


class Worktree(NamedTuple):
    path: Path
    head: str
    branch: str | None
    locked: bool


def scratch_root() -> Path:
    """Claude Code がセッションのスクラッチを置く所。"""
    return Path(tempfile.gettempdir()) / "claude"


def _git_dir(repo: Path) -> Path:
    return Path(run("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=repo, check=True).stdout.strip())


def worktrees(repo: Path) -> list[Worktree]:
    """本体を除く、登録された作業ツリー。"""
    found: list[Worktree] = []
    for block in run("worktree", "list", "--porcelain", cwd=repo, check=True).stdout.split("\n\n"):
        fields = dict(line.split(" ", 1) if " " in line else (line, "") for line in block.splitlines() if line)
        if "worktree" not in fields or "bare" in fields:
            continue
        branch = fields.get("branch")
        found.append(Worktree(Path(fields["worktree"]), fields.get("HEAD", ""),
                              branch.removeprefix("refs/heads/") if branch else None, "locked" in fields))
    return found[1:]


def _same_or_inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _newest_mtime(path: Path, depth: int) -> float:
    """`path` とその下 `depth` 段までの最も新しい更新時刻（node_modules の奥までは見ない）。"""
    newest = path.stat().st_mtime
    if depth > 0 and path.is_dir():
        try:
            entries = list(os.scandir(path))
        except OSError:
            return newest
        for entry in entries:
            try:
                newest = max(newest, _newest_mtime(Path(entry.path), depth - 1) if entry.is_dir(follow_symlinks=False)
                             else entry.stat(follow_symlinks=False).st_mtime)
            except OSError:
                continue
    return newest


def _last_git_activity(worktree: Path) -> float:
    """作業ツリーで最後に git が動いた時刻（作業ツリーごとの index と HEAD は、状態を読む・切り替える・コミットするたびに書かれる）。"""
    admin = Path(run("rev-parse", "--path-format=absolute", "--git-dir", cwd=worktree, check=True).stdout.strip())
    return max((admin / name).stat().st_mtime for name in ("HEAD", "index") if (admin / name).exists())


def _is_ancestor(commit: str, of: str, repo: Path) -> bool:
    return run("merge-base", "--is-ancestor", commit, of, cwd=repo).returncode == 0


def merged_pr_heads(repo: Path) -> dict[str, list[str]]:
    """ブランチ → マージ済みの PR の先頭のコミット。gh が使えなければ空（PR では消さず、master に入ったものだけを消す）。"""
    try:
        result = subprocess.run(
            ["gh", "pr", "list", "--state", "merged", "--limit", "300", "--json", "headRefName,headRefOid"],
            cwd=repo, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return {}
    if result.returncode != 0:
        return {}
    heads: dict[str, list[str]] = {}
    for pr in json.loads(result.stdout or "[]"):
        heads.setdefault(pr["headRefName"], []).append(pr["headRefOid"])
    return heads


def worktree_verdict(worktree: Worktree, *, dirty: bool, idle_seconds: float, in_master: bool,
                     in_merged_pr: bool, protected: bool) -> str | None:
    """消す理由。消さないなら None。"""
    if protected or worktree.locked or dirty or idle_seconds < WORKTREE_IDLE_SECONDS:
        return None
    if in_master:
        return "master に入っている"
    if in_merged_pr:
        return f"{worktree.branch} の PR がマージ済み"
    return None


def _on_rm_error(function, path, _exc) -> None:
    """読み取り専用の印（OneDrive の下・git のオブジェクト）を外して消し直す。"""
    os.chmod(path, stat.S_IWRITE)
    function(path)


def remove_tree(path: Path) -> None:
    shutil.rmtree(path, onexc=_on_rm_error)


def sweep_worktrees(repo: Path, protected: list[Path], *, dry_run: bool) -> tuple[list[str], list[Path]]:
    """反映済みの作業ツリーと指す先の無い登録を消す。消したものの説明と、残した作業ツリーの場所を返す。"""
    run("fetch", "-q", *UPSTREAM.split("/"), cwd=repo)
    removed = _prune_registrations(repo, dry_run=dry_run)
    kept: list[Path] = []
    pr_heads: dict[str, list[str]] | None = None
    for worktree in worktrees(repo):
        if not worktree.path.exists():
            continue
        # 状態を読む前に取る（`git status` は index を書き直すので、読んだあとでは今使われたように見える）。
        idle_seconds = time.time() - _last_git_activity(worktree.path)
        status = run("status", "--porcelain", cwd=worktree.path)
        in_master = bool(worktree.head) and _is_ancestor(worktree.head, UPSTREAM, repo)
        in_merged_pr = False
        if not in_master and worktree.branch:
            pr_heads = merged_pr_heads(repo) if pr_heads is None else pr_heads
            in_merged_pr = any(_is_ancestor(worktree.head, oid, repo) for oid in pr_heads.get(worktree.branch, []))
        reason = worktree_verdict(
            worktree, dirty=status.returncode != 0 or bool(status.stdout.strip()),
            idle_seconds=idle_seconds, in_master=in_master,
            in_merged_pr=in_merged_pr, protected=any(_same_or_inside(p, worktree.path) for p in protected))
        if reason is None:
            kept.append(worktree.path)
            continue
        if not dry_run:
            if run("worktree", "remove", "--force", str(worktree.path), cwd=repo).returncode != 0 or worktree.path.exists():
                remove_tree(worktree.path)
            if worktree.branch:
                run("branch", "-D", worktree.branch, cwd=repo)
        removed.append(f"作業ツリー {worktree.path}（{reason}）")
    return removed, kept


def _prune_registrations(repo: Path, *, dry_run: bool) -> list[str]:
    """指す先の無い登録を消す。`git worktree prune` は黙って消すので先に数え、権限で消せなかった登録は、読み取り専用の印を
    外して消す。"""
    admin_root = _git_dir(repo) / "worktrees"
    stale = []
    for admin in sorted(admin_root.iterdir()) if admin_root.is_dir() else []:
        gitdir = admin / "gitdir"
        target = Path(gitdir.read_text(encoding="utf-8").strip()) if gitdir.is_file() else None
        if target is None or not target.exists():
            stale.append(admin)
    if not dry_run:
        run("worktree", "prune", cwd=repo)
        for admin in stale:
            if admin.exists():
                remove_tree(admin)
    return [f"指す先の無い登録 {admin.name}" for admin in stale]


def sweep_scratch(root: Path, keep: list[Path], session_id: str | None, *, dry_run: bool) -> list[str]:
    """古いスクラッチを消す。`keep` を中に持つスクラッチと、呼んだセッションのスクラッチは消さない。"""
    removed = []
    now = time.time()
    for scratch in sorted(root.glob("*/*/scratchpad")) if root.is_dir() else []:
        if session_id and scratch.parent.name == session_id:
            continue
        if any(_same_or_inside(path, scratch) for path in keep):
            continue
        try:
            idle = now - _newest_mtime(scratch, depth=2)
        except OSError:
            continue
        if idle < SCRATCH_IDLE_SECONDS:
            continue
        if not dry_run:
            remove_tree(scratch)
        removed.append(f"スクラッチ {scratch}（{int(idle // 86400)}日書き換えなし）")
    return removed


def sweep(repo: Path, protected: list[Path], session_id: str | None, *, dry_run: bool) -> list[str]:
    removed, kept = sweep_worktrees(repo, protected, dry_run=dry_run)
    return removed + sweep_scratch(scratch_root(), [*kept, *protected], session_id, dry_run=dry_run)


def _locked_sweep(repo: Path, protected: list[Path], session_id: str | None) -> None:
    """二重に走らないよう印を取ってから片付け、消したものを1行ずつ出す。"""
    root = scratch_root()
    root.mkdir(parents=True, exist_ok=True)
    lock = root / "worktree-sweep.lock"
    if lock.exists() and time.time() - lock.stat().st_mtime < LOCK_STALE_SECONDS:
        return
    lock.write_text(str(os.getpid()), encoding="utf-8")
    try:
        for line in sweep(repo, protected, session_id, dry_run=False):
            print(line, flush=True)
    finally:
        lock.unlink(missing_ok=True)


def _detach(hook_input: dict) -> None:
    """片付けを裏の別のプロセスで始めて、すぐ戻る（消すのに数分かかっても、セッションの始まりを待たせない）。"""
    args = [sys.executable, str(Path(__file__).resolve())]
    if hook_input.get("session_id"):
        args += ["--session", hook_input["session_id"]]
    if hook_input.get("cwd"):
        args += ["--keep", hook_input["cwd"]]
    root = scratch_root()
    root.mkdir(parents=True, exist_ok=True)
    # Windows では窓の無いコンソールで起こす。コンソールを持たない形（DETACHED_PROCESS）で起こすと、子の git が1回ごとに
    # 新しいコンソールの窓を開き、画面がちらつく。
    flags = (subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == "nt" else 0
    # 子は記録のファイルを自分で開いたまま持つので、ここで閉じてよい。
    with open(root / "worktree-sweep.log", "a", encoding="utf-8") as log:
        subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd=REPO_ROOT,
                         creationflags=flags, start_new_session=os.name != "nt")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="残った作業ツリーとスクラッチを片付ける")
    parser.add_argument("--dry-run", action="store_true", help="消すものを出すだけ")
    parser.add_argument("--detach", action="store_true", help="フック用: 標準入力のフックの JSON を読み、裏で片付ける")
    parser.add_argument("--session", help="消さないスクラッチのセッションid")
    parser.add_argument("--keep", action="append", default=[], help="消さない作業ディレクトリ（何度でも）")
    args = parser.parse_args(argv)
    if args.detach:
        try:
            hook_input = json.loads(sys.stdin.read() or "{}")
        except json.JSONDecodeError:
            hook_input = {}
        _detach(hook_input)
        return 0
    protected = [REPO_ROOT, Path.cwd(), *map(Path, args.keep)]
    if args.dry_run:
        for line in sweep(REPO_ROOT, protected, args.session, dry_run=True):
            print(line)
        return 0
    _locked_sweep(REPO_ROOT, protected, args.session)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
