"""道具が git を打つ口と、変更を比べる基準（origin の master）・本体のチェックアウトの場所。

標準ライブラリだけで書く。`backend/` の下の道具もリポジトリの根の `scripts/` を `sys.path` へ足して読み、
その中には依存を入れていない Python で走るもの（`backend/scripts/deploy_gate.py`）がある。
"""

import os
import subprocess
from pathlib import Path

REMOTE = "origin"
BRANCH = "master"
UPSTREAM = f"{REMOTE}/{BRANCH}"


def run(*args: str, cwd: Path | str | None = None, check: bool = False) -> subprocess.CompletedProcess[str]:
    """`cwd`（省けば今の作業ディレクトリ）で `git <args>` を打つ。`check` なら、失敗を git の言い分つきの例外にする。"""
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True,
        # 既定の文字コードに任せると、Windows の開発機では日本語を含むパス・文の出力を読めない。
        text=True, encoding="utf-8", errors="replace", check=False,
        # 資格情報を端末で尋ねられると、フックも道具も入力を待ったまま止まる。
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {result.stderr.strip()}")
    return result


def merge_base(head: str = "HEAD", base: str = UPSTREAM, cwd: Path | str | None = None) -> str:
    """`head` と `base` の合流点のコミット。道具が「この変更」を見るときの比べる基準。取れなければ例外。"""
    return run("merge-base", base, head, cwd=cwd, check=True).stdout.strip()


def main_checkout(cwd: Path | str) -> Path:
    """`cwd` が属するリポジトリの本体のチェックアウト（作業ツリーから見ても、作業ツリーを持つ側）。

    git の無視するファイル（`.env` 等）は作業ツリーへ写らないので、それを読む道具がここから探す。
    """
    common = run("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=cwd, check=True).stdout.strip()
    return Path(common).parent
