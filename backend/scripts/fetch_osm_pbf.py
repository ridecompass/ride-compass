r"""OSMの抽出ファイル（`.pbf`）を配布元から手元へ写す（取込とは分ける）。

取込はローカルのファイルを読むだけにする。手で落とすと、置き場所と名前を間違えたまま
「取得済み」に見える。

取得の手順（手元にあるものは落とし直さない・一時ファイル経由）は
`app.batch.common.fetch_once`が持つ。

どのファイルを要するかはプロファイルが持つ（wayのソースの`rows.file`）。配布元の
URLの組み立て方だけがここにある。

実行方法（backendディレクトリから）:
    .venv\Scripts\python.exe scripts\fetch_osm_pbf.py
    .venv\Scripts\python.exe scripts\fetch_osm_pbf.py --profile path/to/profile.yaml
"""

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.batch.common import fetch_once
from app.batch.fetch_cli import run_profile_fetch_cli
from app.batch.source_adapters.osm_pbf import DATA_DIR
from app.batch.source_profile import SourceProfile, SourceSpec

logger = logging.getLogger("ridecompass.fetch_osm_pbf")

#: 配布元。`{name}`は抽出ファイルの名前（`kanto-latest.osm.pbf`等）。
#: Geofabrikの日本の抽出は`asia/japan/`の下に地方ごとに置かれている。
PBF_URL = "https://download.geofabrik.de/asia/japan/{name}"

_READ_TIMEOUT_SECONDS = 60.0


def _fetch_specs(args: argparse.Namespace, profile: SourceProfile, specs: list[SourceSpec]) -> bool:
    for name in sorted({spec.rows.file for spec in specs}):
        fetch_once(PBF_URL.format(name=name), DATA_DIR / name, read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="OSMの抽出ファイルを手元へ写す")
    # wayのソースが読むファイル。頂点のソースは参照先のwayと同じファイルを読むので数えない。
    return run_profile_fetch_cli(parser, "osm_pbf_way", _fetch_specs, logger=logger)


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
