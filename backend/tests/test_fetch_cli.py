"""`batch/fetch_cli.py`——取得の道具の入口の骨格。

入口は`run_profile_fetch_cli`。見るのは、`--profile`で渡したプロファイルのソースを取りに行くこと。

ここで見ないもの:
- 取得を流したあとの終了コード・通信の失敗の扱い → 各取得の道具のテスト（`test_fetch_*.py`）
"""

import argparse
import logging
import sys
from pathlib import Path

import yaml

from app.batch.fetch_cli import run_profile_fetch_cli


def test_fetches_the_sources_of_the_given_profile(tmp_path: Path, monkeypatch):
    path = tmp_path / "profile.yaml"
    path.write_text(yaml.safe_dump({
        "version": 1,
        "target": {"bbox": [35.0, 139.0, 36.0, 140.0]},
        "sources": [{"name": "given-accident", "adapter": "npa_honhyo", "rows": {"years": [2024]}}],
    }), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["fetch", "--profile", str(path)])
    fetched: list[str] = []

    def fetch(args, profile, specs) -> bool:
        fetched.extend(spec.name for spec in specs)
        return True

    code = run_profile_fetch_cli(argparse.ArgumentParser(), "npa_honhyo", fetch, logger=logging.getLogger(__name__))

    assert code == 0
    assert fetched == ["given-accident"]
