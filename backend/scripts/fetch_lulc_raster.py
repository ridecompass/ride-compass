"""置き場に土地被覆のラスタが1枚も無ければ、配布元から取る（デプロイが呼ぶ）。

取り方は土地被覆のアダプタ（`app/batch/source_adapters/io_lulc_tile.py: fetch_lulc_rasters`）が持つ。
取得の入口（`python -m app.batch.fetch_cli --source lulc`）と違って置き場を消さず、ラスタがあれば配布元に新しい年が
出ていても触らない——デプロイのたびに起動しても、2回目以降は置き場を見るだけで終わる。新しい年へ替えるのは取得の入口。

実行方法（backendディレクトリから）:
    .venv\\Scripts\\python.exe scripts\\fetch_lulc_raster.py
"""

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.batch.fetch_cli import run_fetch_cli
from app.batch.source_adapters.io_lulc_tile import fetch_lulc_rasters
from app.batch.source_profile import load_source_profile
from app.infrastructure.landcover_raster import raster_paths

logger = logging.getLogger("ridecompass.fetch_lulc_raster")


def fetch() -> bool:
    if paths := raster_paths():
        logger.info("置き場にラスタがあるので取らない paths=%s", paths)
        return True
    profile = load_source_profile(None)
    fetch_lulc_rasters(profile.source("lulc"), profile)
    return True


def main() -> int:
    return run_fetch_cli(fetch, logger=logger)


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
