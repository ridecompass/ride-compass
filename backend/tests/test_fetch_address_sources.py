"""住所の区画の元データのうち、版を配布元の一覧から決めて取るもの（アダプタ`isj_block`・`estat_small_area`の取得）。

入口は取得の入口（`app/batch/fetch_cli.py: fetch_sources`）。配布元の応答（`respx_mock`）と置き場だけを差し替え、範囲に掛かる
都道府県を手元の ABR の市区町村の代表点から決めて、配布元の一覧の最も新しい版を取り、その版を記録することを確かめる。

ここで見ないもの:
- 置き場を消して取り直すこと → `test_fetch_cli.py`
- 置いた配布の読み方 → `test_address_areas.py`・`test_stop_place_areas.py`
"""

import zipfile

import pytest

from app.batch.common import read_fetch_record
from app.batch.fetch_cli import fetch_sources
from app.batch.source_adapters import abr, estat_small_area, isj_block
from app.infrastructure.source_models import Source
from tests.source_ingest import profile_within

#: 東京都（新宿区の代表点）だけに掛かる範囲（min_lat, min_lon, max_lat, max_lon）。
PROFILE = profile_within((35.68, 139.69, 35.70, 139.71))


@pytest.fixture
def tokyo_only(monkeypatch, tmp_path):
    """範囲に掛かる都道府県を東京都に決める ABR の市区町村の代表点と、空の置き場。"""
    monkeypatch.setattr(abr, "DATA_DIR", tmp_path / "abr")
    monkeypatch.setattr(isj_block, "DATA_DIR", tmp_path / "isj")
    monkeypatch.setattr(estat_small_area, "DATA_DIR", tmp_path / "estat")
    path = abr.archive_path("mt_city_pos_all")
    path.parent.mkdir(parents=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("mt_city_pos_all.csv", "lg_code,rep_lon,rep_lat\r\n131041,139.70,35.69\r\n")


def _files_page(*versions: str) -> bytes:
    """配布の一覧の画面（行ごとに版の欄を持つ表）。"""
    rows = "".join(f'<tr><td align="center"><font size="2">{version}</font></td></tr>' for version in versions)
    return f"<table>{rows}</table>".encode("euc-jp")


@pytest.mark.usefixtures("tokyo_only")
def test_isj_takes_the_newest_block_level_version_of_the_whole_prefecture(respx_mock):
    """古い版を取ると、新しい地番が入らない。大字・町丁目レベルの版（末尾が`b`）を取ると、地番の点の無い配布を取る。"""
    respx_mock.post(isj_block.CITIES_URL, data={"sbm": "1", "pc": "13"}).respond(content=(
        '<input type="checkbox" value="0930" name="ac" id="_ac13000"><span>市区町村全域</span>'
        '<input type="checkbox" value="0931" name="ac" id="_ac13101"><span>千代田区</span>').encode("euc-jp"))
    respx_mock.post(isj_block.FILES_URL, data={"sbm": "1", "pc": "13", "ac": "0930"}).respond(
        content=_files_page("9.0a", "25.0b", "24.0a", "10.0a"))
    archive = b"given"
    respx_mock.get(isj_block.DOWNLOAD_URL.format(version="24.0a", prefecture="13")).respond(content=archive)

    fetch_sources(PROFILE, [Source.ISJ_BLOCK])

    assert isj_block.archive_path("13").read_bytes() == archive
    assert read_fetch_record(isj_block.DATA_DIR)["versions"] == {"13": "24.0a"}


@pytest.mark.usefixtures("tokyo_only")
def test_estat_takes_the_newest_census_small_area_survey(respx_mock):
    """古い国勢調査を取ると、今の町丁・字と境界がずれる。小地域でない境界（識別子の頭が違う）を取ると、施設の辺りの名前が出ない。"""
    respx_mock.get(estat_small_area.SURVEYS_URL).respond(json={"detail": (
        '<a href="?serveyId=A002005212015">平成27年</a><a href="?serveyId=A002005212020">令和2年</a>'
        '<a href="?serveyId=D002005212025">令和7年（別の集計の単位）</a>')})
    archive = b"given"
    respx_mock.get(estat_small_area.DOWNLOAD_URL.format(survey="A002005212020", prefecture="13")).respond(content=archive)

    fetch_sources(PROFILE, [Source.ESTAT_SMALL_AREA])

    assert estat_small_area.boundary_path("13").read_bytes() == archive
    assert read_fetch_record(estat_small_area.DATA_DIR)["survey"] == "A002005212020"
