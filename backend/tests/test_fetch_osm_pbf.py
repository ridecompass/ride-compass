"""OSMの抽出ファイルの取得（アダプタ`osm_pbf`の取得）。

入口は取得の入口（`app/batch/fetch_cli.py: fetch_sources`）。配布元の応答と置き場だけを差し替え、何を取りに行くかは本物の
プロファイルから導く。見るのは、取込が開くファイルを取りに行くこと。

ここで見ないもの:
- 置き場を消して取り直すこと・分けて届いた応答をつなぐこと → `test_fetch_cli.py`
"""

from app.batch.fetch_cli import fetch_sources
from app.batch.source_adapters import osm_pbf
from app.batch.source_profile import load_source_profile


def test_default_profile_fetches_the_file_the_ingest_reads(tmp_path, monkeypatch, respx_mock):
    """プロファイルがファイル名を書いていなくても、取込が開くファイルを配布元（Geofabrik の日本の抽出）から取りに行く。
    応答は配布元のそのファイルの URL にだけ与える（ほかの URL への要求は`respx_mock`が落とす）。"""
    profile = load_source_profile(None)
    specs = [spec for spec in profile.sources if isinstance(spec.rows, osm_pbf.OsmWayRows)]
    ingested = {spec.rows.file for spec in specs}
    assert ingested
    for name in ingested:
        respx_mock.get(f"https://download.geofabrik.de/asia/japan/{name}").respond(content=b"pbf")
    store = tmp_path / "pbf"
    monkeypatch.setattr(osm_pbf, "DATA_DIR", store)

    fetch_sources(profile, [spec.name for spec in specs])

    assert sorted(p.name for p in store.iterdir()) == sorted(ingested)
