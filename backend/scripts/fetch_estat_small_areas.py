r"""e-Stat の小地域の境界（国勢調査の町丁・字等、Shapefile）を配布元から手元へ写す（取込とは分ける）。

取込はローカルのファイルを読むだけにする（`source_adapters/estat_small_area.py`）。

取るのは取込の範囲に掛かる都道府県の zip（1都道府県1つ）。都道府県はアドレス・ベース・レジストリの市区町村の代表点から
決める（`source_adapters/abr.py: range_prefectures`）ので、先に`scripts/fetch_abr.py`を流しておく。
取得の手順は`app.batch.common.fetch_verified`が持つ。どの調査の境界かはプロファイルが持つ（`estat_small_area`ソースの
`rows.survey`）。

実行方法（backendディレクトリから）:
    .venv\Scripts\python.exe scripts\fetch_estat_small_areas.py
    .venv\Scripts\python.exe scripts\fetch_estat_small_areas.py --profile path/to/profile.yaml
"""

import argparse
import logging
import sys
import zipfile
import zlib
from pathlib import Path

import shapefile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.batch.common import fetch_verified, fetched_all
from app.batch.fetch_cli import run_profile_fetch_cli
from app.batch.source_adapters.abr import abr_snapshot, range_prefectures
from app.batch.source_adapters.estat_small_area import (
    DOWNLOAD_URL,
    boundary_path,
    open_shapefile,
)
from app.batch.source_profile import SourceProfile, SourceSpec

logger = logging.getLogger("ridecompass.fetch_estat_small_areas")

_READ_TIMEOUT_SECONDS = 300.0


def _readable(path: Path) -> bool:
    """Shapefile を持つ zip で、1件以上の境界があるか。"""
    try:
        with zipfile.ZipFile(path) as archive:
            return len(open_shapefile(archive)) > 0
    except (OSError, KeyError, zipfile.BadZipFile, zlib.error, shapefile.ShapefileException):
        return False


def _fetch_specs(args: argparse.Namespace, profile: SourceProfile, specs: list[SourceSpec]) -> bool:
    surveys = sorted({spec.rows.survey for spec in specs})
    prefectures = range_prefectures(abr_snapshot(profile), profile.target)
    logger.info("範囲に掛かる都道府県: %s", ", ".join(prefectures))
    return fetched_all(
        fetch_verified(DOWNLOAD_URL.format(survey=survey, prefecture=code), boundary_path(survey, code), _readable,
                       read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)
        for survey in surveys for code in prefectures)


def main() -> int:
    parser = argparse.ArgumentParser(description="e-Stat の小地域の境界を手元へ写す")
    return run_profile_fetch_cli(parser, "estat_small_area", _fetch_specs, logger=logger)


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
