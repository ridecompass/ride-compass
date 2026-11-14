"""土地被覆ラスタの取得（scripts/fetch_lulc_raster.py。デプロイが呼ぶ）。

入口は`main`。実ダウンロード（70MB規模）はテストで行わず、配布元の応答と置き場の設定だけを差し替えて、
設定のファイル名でバケットから取ることと、手元にあるものは取り直さないことを確かめる。
配布元へ応答を与えていない要求は`respx_mock`が落とすので、取りに行かないことは応答を与えないことで見る。

ここで見ないもの:
- 取得の入口（`app/batch/fetch_cli.py: fetch_sources`）が置き場を消して取り直すこと → `test_fetch_cli.py`
"""

from app.batch.source_adapters.io_lulc_tile import BUCKET_BASE_URL
from app.config import settings
from scripts import fetch_lulc_raster


def test_downloads_the_raster_named_by_the_setting_from_the_bucket(tmp_path, monkeypatch, respx_mock):
    # バケット内のキーは設定されたパスのファイル名そのもの（ゾーン・年は設定側の決定）。
    respx_mock.get(f"{BUCKET_BASE_URL}/54S_2024.tif").respond(content=b"raster")
    destination = tmp_path / "raster" / "54S_2024.tif"
    monkeypatch.setattr(settings, "lulc_raster_paths", str(destination))

    assert fetch_lulc_raster.main() == 0

    assert destination.read_bytes() == b"raster"


def test_keeps_the_raster_already_in_place(tmp_path, monkeypatch, respx_mock):
    """デプロイのたびに呼ばれるので、取り直すと毎回70MB規模を落とす。"""
    destination = tmp_path / "54S_2024.tif"
    destination.write_bytes(b"previous")
    monkeypatch.setattr(settings, "lulc_raster_paths", str(destination))

    assert fetch_lulc_raster.main() == 0

    assert destination.read_bytes() == b"previous"
