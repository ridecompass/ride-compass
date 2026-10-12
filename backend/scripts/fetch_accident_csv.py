r"""警察庁の交通事故統計（本票CSV）を配布元から手元へ写す（取込とは分ける）。

取込はローカルのファイルを読むだけにする（`source_adapters/npa_honhyo.py`）。

取得の手順（読めるものは落とし直さない・一時ファイル経由・落とし終えたら開いてみる）は
`app.batch.common.fetch_verified`が持つ。

どの年を要するかはプロファイルが持つ（`npa_honhyo`ソースの`rows.years`）。配布元のURLの
組み立て方だけがここにある。

実行方法（backendディレクトリから）:
    .venv\Scripts\python.exe scripts\fetch_accident_csv.py
    .venv\Scripts\python.exe scripts\fetch_accident_csv.py --profile path/to/profile.yaml
"""

import argparse
import csv
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.batch.common import fetch_verified, run_profile_fetch_cli
from app.batch.source_adapters.npa_honhyo import ENCODING, honhyo_path
from app.batch.source_profile import SourceProfile, SourceSpec

logger = logging.getLogger("ridecompass.fetch_accident_csv")

#: 配布元。年ごとに1ファイル。
HONHYO_URL_TEMPLATE = (
    "https://www.npa.go.jp/publications/statistics/koutsuu/opendata/{year}/honhyo_{year}.csv")

_READ_TIMEOUT_SECONDS = 120.0


def _readable(path: Path) -> bool:
    """本票として読めるか（見出しと1行以上）。"""
    try:
        with open(path, encoding=ENCODING, newline="") as f:
            reader = csv.DictReader(f)
            return bool(reader.fieldnames) and next(reader, None) is not None
    except (OSError, UnicodeDecodeError, csv.Error):
        return False


def fetch(years: list[int]) -> bool:
    return all([
        fetch_verified(HONHYO_URL_TEMPLATE.format(year=year), honhyo_path(year), _readable,
                       read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)
        for year in years
    ])


def _fetch_specs(args: argparse.Namespace, profile: SourceProfile, specs: list[SourceSpec]) -> bool:
    return fetch(sorted({int(year) for spec in specs for year in spec.rows.years}))


def main() -> int:
    parser = argparse.ArgumentParser(description="警察庁の本票CSVを手元へ写す")
    return run_profile_fetch_cli(parser, "npa_honhyo", _fetch_specs, logger=logger)


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
