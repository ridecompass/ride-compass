"""backendがディスクへ置くもの（キャッシュ・同期したファイル・道路網の置き場等）の根。

本番ではホストのディレクトリをこの場所へ載せる（`deploy-backend.yml`の`-v`）ので、コンテナを入れ替えても中身が残る。
"""

from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"

#: 土地被覆のラスタ（配布元のGeoTIFF）の置き場。本番では`DATA_DIR`と別のホストのディレクトリを載せる——`DATA_DIR`の
#: キャッシュと違い、消えると取り直すまで土地被覆を配れない。
RASTER_DIR = DATA_DIR.parent / "raster"
