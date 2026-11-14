"""OSMの抽出ファイルの取得（scripts/fetch_osm_pbf.py）。

入口は`main`。配布元の応答と置き場だけを差し替え、何を取りに行くかは本物のプロファイルから導く。
見るのは、取込が開くファイルを取りに行くこと。

ここで見ないもの:
- 一時ファイル経由の取得・手元にあるものを落とし直さない手順（`app/batch/common.py: fetch_once`）
  → `test_fetch_accident_csv.py`
"""

import sys

from app.batch.source_adapters.osm_pbf import OsmWayRows
from app.batch.source_profile import load_source_profile
from scripts import fetch_osm_pbf


def test_default_profile_fetches_the_file_the_ingest_reads(tmp_path, monkeypatch, respx_mock):
    """プロファイルがファイル名を書いていなくても、取込が開くファイルを配布元（Geofabrik の日本の抽出）から取りに行く。
    応答は配布元のそのファイルの URL にだけ与える（ほかの URL への要求は`respx_mock`が落とす）。"""
    ingested = {spec.rows.file for spec in load_source_profile(None).sources
                if isinstance(spec.rows, OsmWayRows)}
    assert ingested
    for name in ingested:
        respx_mock.get(f"https://download.geofabrik.de/asia/japan/{name}").respond(content=b"pbf")
    store = tmp_path / "pbf"
    monkeypatch.setattr(fetch_osm_pbf, "DATA_DIR", store)
    monkeypatch.setattr(sys, "argv", ["fetch_osm_pbf.py"])

    assert fetch_osm_pbf.main() == 0

    assert sorted(p.name for p in store.iterdir()) == sorted(ingested)
