r"""国土交通省の街区レベル位置参照情報（都道府県ごとの zip）を配布元から手元へ写す（取込とは分ける）。

取込はローカルのファイルを読むだけにする（`source_adapters/isj_block.py`）。

取るのは取込の範囲に掛かる都道府県の zip（1都道府県1つ）。都道府県はアドレス・ベース・レジストリの市区町村の代表点から
決める（`source_adapters/estat_small_area.py: range_prefectures`）ので、先に`scripts/fetch_abr.py`を流しておく。
取得の手順は`app.batch.common.fetch_verified`が持つ。どの版かはプロファイルが持つ（`isj_block`ソースの`rows.version`）。

実行方法（backendディレクトリから）:
    .venv\Scripts\python.exe scripts\fetch_isj_blocks.py
    .venv\Scripts\python.exe scripts\fetch_isj_blocks.py --profile path/to/profile.yaml
"""

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.batch.common import fetch_verified, fetched_all
from app.batch.fetch_cli import run_profile_fetch_cli
from app.batch.source_adapters.estat_small_area import range_prefectures
from app.batch.source_adapters.isj_block import DOWNLOAD_URL, ENCODING, archive_path
from app.batch.source_adapters.zip_csv import zip_csv_readable
from app.batch.source_profile import SourceProfile, SourceSpec

logger = logging.getLogger("ridecompass.fetch_isj_blocks")

_READ_TIMEOUT_SECONDS = 300.0


def _readable(path: Path) -> bool:
    """見出しに街区符号・地番があり、1行以上あるか。"""
    return zip_csv_readable(path, ENCODING, "街区符号・地番")


def _fetch_specs(args: argparse.Namespace, profile: SourceProfile, specs: list[SourceSpec]) -> bool:
    versions = sorted({spec.rows.version for spec in specs})
    prefectures = range_prefectures(profile)
    logger.info("範囲に掛かる都道府県: %s", ", ".join(prefectures))
    return fetched_all(
        fetch_verified(DOWNLOAD_URL.format(version=version, prefecture=code), archive_path(version, code), _readable,
                       read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)
        for version in versions for code in prefectures)


def main() -> int:
    parser = argparse.ArgumentParser(description="街区レベル位置参照情報を手元へ写す")
    return run_profile_fetch_cli(parser, "isj_block", _fetch_specs, logger=logger)


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
