"""土地被覆ラスタの取得（scripts/fetch_lulc_raster.py）。

入口は`main`。実ダウンロード（70MB規模）はテストで行わず、配布元の応答と置き場の設定だけを差し替えて、
設定のファイル名でバケットから取ることを確かめる。

ここで見ないもの:
- 一時ファイル経由の取得・手元にあるものを落とし直さない手順（`app/batch/common.py: fetch_once`）
  → `test_fetch_accident_csv.py`
"""

from app.config import settings
from scripts import fetch_lulc_raster


def test_downloads_the_raster_named_by_the_setting_from_the_bucket(tmp_path, monkeypatch, respx_mock):
    # バケット内のキーは設定されたパスのファイル名そのもの（ゾーン・年は設定側の決定）。
    respx_mock.get(f"{fetch_lulc_raster.BUCKET_BASE_URL}/54S_2024.tif").respond(content=b"raster")
    destination = tmp_path / "raster" / "54S_2024.tif"
    monkeypatch.setattr(settings, "lulc_raster_paths", str(destination))

    assert fetch_lulc_raster.main() == 0

    assert destination.read_bytes() == b"raster"
