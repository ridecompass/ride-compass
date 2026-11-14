r"""アドレス・ベース・レジストリ（都道府県・市区町村・町字・住居表示の街区のテキストと位置参照拡張）を配布元から手元へ写す
（取込とは分ける）。

取込はローカルのファイルを読むだけにする（`source_adapters/abr.py`）。

取るのは全国の1ファイルずつ（都道府県・市区町村・町字のテキストと、都道府県・市区町村の代表点）と、町字の代表点と
住居表示の街区のテキストと代表点のうち取込の範囲（`target.bbox`）に掛かる都道府県のもの（`source_adapters/abr.py: range_prefectures`。市区町村の代表点から
決めるので、市区町村の代表点を先に取る）。取得の手順（手元にあるものは落とし直さない・一時ファイル経由）は
`app.batch.common.fetch_once`が持つ。

置き場の名前はプロファイルの取った日（`abr`ソースの`rows.snapshot`）で決まる。取り直すときは日を変える。

実行方法（backendディレクトリから）:
    .venv\Scripts\python.exe scripts\fetch_abr.py
    .venv\Scripts\python.exe scripts\fetch_abr.py --profile path/to/profile.yaml
"""

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.batch.common import fetch_once
from app.batch.fetch_cli import run_profile_fetch_cli
from app.batch.source_adapters.abr import (
    NATIONWIDE_ARCHIVES,
    archive_path,
    archive_url,
    prefecture_stems,
    range_prefectures,
)
from app.batch.source_profile import SourceProfile, SourceSpec, Target

logger = logging.getLogger("ridecompass.fetch_abr")

_READ_TIMEOUT_SECONDS = 120.0


def _fetch(snapshot: str, stem: str) -> None:
    fetch_once(archive_url(stem), archive_path(snapshot, stem), read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)


def fetch(snapshot: str, target: Target) -> None:
    for stem in NATIONWIDE_ARCHIVES:
        _fetch(snapshot, stem)
    prefectures = range_prefectures(snapshot, target)
    logger.info("範囲に掛かる都道府県: %s", ", ".join(prefectures))
    for code in prefectures:
        for stem in prefecture_stems(code):
            _fetch(snapshot, stem)


def _fetch_specs(args: argparse.Namespace, profile: SourceProfile, specs: list[SourceSpec]) -> bool:
    for snapshot in sorted({spec.rows.snapshot for spec in specs}):
        fetch(snapshot, profile.target)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="アドレス・ベース・レジストリを手元へ写す")
    return run_profile_fetch_cli(parser, "abr", _fetch_specs, logger=logger)


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
