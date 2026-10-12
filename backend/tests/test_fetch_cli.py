"""`batch/fetch_cli.py`——取得の道具の入口の骨格。

入口は`run_profile_fetch_cli`。見るのは、`--profile`で渡したプロファイルとそのソースを、読んだ引数と一緒に取得へ渡すことと、
アダプタのソースが無ければ取らずに成功で終えることと、通信に失敗したら落ちずに失敗の終了コードを返すこと。

ここで見ないもの:
- 取得が置けたかどうかの終了コード → 各取得の道具のテスト（`test_fetch_*.py`）
"""

import argparse
import logging
import sys
from pathlib import Path

import httpx
import yaml

from app.batch.fetch_cli import run_profile_fetch_cli


def _write_profile(tmp_path: Path) -> Path:
    path = tmp_path / "profile.yaml"
    path.write_text(yaml.safe_dump({
        "version": 1,
        "target": {"bbox": [35.0, 139.0, 36.0, 140.0]},
        "sources": [{"name": "given-accident", "adapter": "npa_honhyo", "rows": {"years": [2024]}}],
    }), encoding="utf-8")
    return path


def test_fetches_the_sources_of_the_given_profile_with_the_parsed_args(tmp_path: Path, monkeypatch):
    path = _write_profile(tmp_path)
    monkeypatch.setattr(sys, "argv", ["fetch", "--profile", str(path), "--out", "given-out"])
    parser = argparse.ArgumentParser()
    parser.add_argument("--out")
    fetched: list[tuple[str, str, tuple[float, float, float, float]]] = []

    def fetch(args, profile, specs) -> bool:
        fetched.extend((spec.name, args.out, profile.target.bbox) for spec in specs)
        return True

    code = run_profile_fetch_cli(parser, "npa_honhyo", fetch, logger=logging.getLogger(__name__))

    assert code == 0
    assert fetched == [("given-accident", "given-out", (35.0, 139.0, 36.0, 140.0))]


def test_succeeds_without_fetching_when_the_profile_has_no_source_of_the_adapter(tmp_path: Path, monkeypatch):
    path = _write_profile(tmp_path)
    monkeypatch.setattr(sys, "argv", ["fetch", "--profile", str(path)])
    called: list[bool] = []

    def fetch(args, profile, specs) -> bool:
        called.append(True)
        return False

    code = run_profile_fetch_cli(argparse.ArgumentParser(), "abr", fetch, logger=logging.getLogger(__name__))

    assert code == 0
    assert called == []


def test_fails_without_raising_when_the_fetch_fails_to_communicate(tmp_path: Path, monkeypatch):
    path = _write_profile(tmp_path)
    monkeypatch.setattr(sys, "argv", ["fetch", "--profile", str(path)])

    def fetch(args, profile, specs) -> bool:
        raise httpx.ConnectError("given failure")

    code = run_profile_fetch_cli(argparse.ArgumentParser(), "npa_honhyo", fetch, logger=logging.getLogger(__name__))

    assert code == 1
