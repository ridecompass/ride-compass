"""計測した作業コピーの素性（HEAD・未コミットの変更）と、origin/master に追いついているかを出す。

ベンチマークの数字はタスクエントリへ「本番実測」として引用される。どのコードを測ったかが
数字と一緒に残っていないと、作業コピーが古いまま測ったときに出るのはエラーではなく
「古いコードのもっともらしい数字」になり、後から気づく手段が無い。
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from checkout_freshness import REPO_ROOT, staleness
from repo_git import run


@dataclass(frozen=True)
class RevisionState:
    head: str | None
    dirty: bool


def read_revision_state() -> RevisionState:
    """作業コピーのHEADと、未コミットの変更があるか。"""
    head = run("rev-parse", "HEAD", cwd=REPO_ROOT)
    status = run("status", "--porcelain", cwd=REPO_ROOT)
    return RevisionState(head=head.stdout.strip() if head.returncode == 0 else None,
                         dirty=bool(status.stdout.strip()))


def describe(state: RevisionState) -> str:
    """結果へ添える1行。どのコードを測ったかを数字と同じ出力に残す。"""
    head = state.head[:12] if state.head else "不明"
    parts = [f"計測した作業コピー: {head}"]
    if state.dirty:
        parts.append("未コミットの変更あり")
    return "（" + "／".join(parts) + "）"


def announce_revision() -> None:
    """素性を1行出し、古ければ（古いかを確かめられなければ）警告を出す（止めない）。

    個別のベンチは手元の反復でも使うため、遅れたコミットでも測れる方を採る。
    止めないぶん、**どのコードを測ったかは必ず出力へ残る**——数字だけが後から引用されると、
    古い作業コピーの数字かどうかを見分ける手段が無くなる。
    """
    print(describe(read_revision_state()))
    reason = staleness()
    if reason is not None:
        print(f"警告: {reason}")
