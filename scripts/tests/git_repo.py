"""テストが一時ディレクトリに作るgitのリポジトリを操作する道具。"""

from pathlib import Path

from repo_git import run


def git(repo: Path, *args: str) -> str:
    """`repo`で`git <args>`を打ち、標準出力を返す。コミットの名義は使い捨てのもので、開発機の設定を読まない。"""
    return run("-c", "user.name=t", "-c", "user.email=t@example.invalid", *args, cwd=repo, check=True).stdout.strip()
