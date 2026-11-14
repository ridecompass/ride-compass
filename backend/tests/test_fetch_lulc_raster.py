"""土地被覆ラスタの取得。取得の入口（`app/batch/fetch_cli.py: fetch_sources`）の`lulc`と、デプロイが呼ぶ
`scripts/fetch_lulc_raster.py`の`main`。

実ダウンロード（70MB規模）はテストで行わず、配布元（STACの品目の検索とバケット）の応答と置き場（フィクスチャ`raster_dir`）
だけを差し替える。配布元へ応答を与えていない要求は`respx_mock`が落とすので、取りに行かないことは応答を与えないことで見る。

ここで見ないもの:
- 取得の入口が、取得を持つ元を宣言の順に呼ぶこと → `test_fetch_cli.py`
"""

from app.batch.fetch_cli import fetch_sources
from app.batch.source_adapters.io_lulc_tile import COLLECTION, STAC_SEARCH_URL
from app.batch.source_profile import load_source_profile
from scripts import fetch_lulc_raster

BUCKET = "https://io-10m-annual-lulc.s3.us-west-2.amazonaws.com"
NEXT_PAGE = f"{STAC_SEARCH_URL}?token=next"


def item(zone: str, year: int, href_base: str = BUCKET) -> dict:
    return {
        "id": f"{zone}-{year}",
        "properties": {"datetime": f"{year}-01-01T00:00:00Z"},
        "assets": {"supercell": {"href": f"{href_base}/{zone}_{year}.tif"}},
    }


def answer_search(respx_mock, profile) -> None:
    """範囲に掛かる2ゾーンの品目を、2ページに分けて返す（新しい年は2ページ目にある）。"""
    min_lat, min_lon, max_lat, max_lon = profile.target.bbox
    respx_mock.get(STAC_SEARCH_URL, params={
        "collections": COLLECTION, "bbox": f"{min_lon},{min_lat},{max_lon},{max_lat}"}).respond(json={
            "features": [item("54S", 2023, "https://s3.us-west-2.amazonaws.com/io-10m-annual-lulc"), item("53S", 2024)],
            "links": [{"rel": "next", "href": NEXT_PAGE}],
        })
    respx_mock.get(NEXT_PAGE).respond(json={"features": [item("54S", 2024)], "links": []})


def test_the_fetch_entry_replaces_the_store_with_the_latest_year_of_each_zone(raster_dir, respx_mock):
    """新しい年が出たら、置き場の前の年を残さずに替える（両方残ると、取込と地図が古い年の画素も読む）。"""
    (raster_dir / "54S_2023.tif").write_bytes(b"previous year")
    profile = load_source_profile(None)
    answer_search(respx_mock, profile)
    respx_mock.get(f"{BUCKET}/54S_2024.tif").respond(content=b"54S latest")
    respx_mock.get(f"{BUCKET}/53S_2024.tif").respond(content=b"53S latest")

    fetch_sources(profile, ["lulc"])

    assert {path.name: path.read_bytes() for path in raster_dir.iterdir()} == {
        "54S_2024.tif": b"54S latest", "53S_2024.tif": b"53S latest"}


def test_the_deploy_fetches_into_an_empty_store(raster_dir, respx_mock):
    answer_search(respx_mock, load_source_profile(None))
    respx_mock.get(f"{BUCKET}/54S_2024.tif").respond(content=b"54S latest")
    respx_mock.get(f"{BUCKET}/53S_2024.tif").respond(content=b"53S latest")

    assert fetch_lulc_raster.main() == 0

    assert sorted(path.name for path in raster_dir.iterdir()) == ["53S_2024.tif", "54S_2024.tif"]


def test_the_deploy_keeps_the_rasters_already_in_place(raster_dir, respx_mock):
    """デプロイのたびに呼ばれるので、取り直すと毎回70MB規模を落とす。"""
    (raster_dir / "54S_2023.tif").write_bytes(b"previous")

    assert fetch_lulc_raster.main() == 0

    assert (raster_dir / "54S_2023.tif").read_bytes() == b"previous"
