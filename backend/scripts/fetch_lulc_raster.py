"""土地被覆ラスタ（Esri×Impact Observatory Sentinel-2 10m Annual LULC）を取得する。

`settings.lulc_raster_paths`（環境変数`LULC_RASTER_PATHS`）が指すファイルのうち、まだ
手元に無いものを配布元からダウンロードする。
あるものには触らない（デプロイのたびに起動しても、2回目以降は存在を見るだけで終わる）。

取得元はAWS S3の公開バケット（サインなしで読める）。ファイル名はUTMゾーンと年
（例: `54S_2024.tif`）で、設定されたパスのファイル名部分をそのままバケット内のキーとして
使う——どのゾーン・どの年を使うかは設定側の決定で、このスクリプトは持たない。

取得の手順（一時ファイル経由）は`app.batch.common.fetch_once`が持つ。

実行方法（backendディレクトリから）:
    .venv\\Scripts\\python.exe scripts\\fetch_lulc_raster.py
"""

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.batch.common import fetch_once
from app.batch.fetch_cli import run_fetch_cli
from app.config import settings

logger = logging.getLogger("ridecompass.fetch_lulc_raster")

#: 配布元。`aws s3 cp --no-sign-request`と同じ内容をHTTPSで取得する（認証もCLIも要らない）。
BUCKET_BASE_URL = "https://io-10m-annual-lulc.s3.us-west-2.amazonaws.com"

_READ_TIMEOUT_SECONDS = 600.0


def fetch() -> bool:
    for raw_path in settings.lulc_raster_paths_list:
        fetch_once(f"{BUCKET_BASE_URL}/{Path(raw_path).name}", Path(raw_path),
                   read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)
    return True


def main() -> int:
    return run_fetch_cli(fetch, logger=logger)


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
