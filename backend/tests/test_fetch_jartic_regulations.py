"""JARTIC の交通規制情報の取得（アダプタ`jartic_regulation`の取得）。

入口は取得の入口（`app/batch/fetch_cli.py: fetch_sources`）。配布元の応答（`respx_mock`）と置き場だけを差し替え、範囲に掛かる
都道府県を手元の ABR の市区町村の代表点から決めて、そのファイルを一覧の対応から引いて置き、一覧が指す版を記録することを確かめる。

ここで見ないもの:
- 置き場を消して取り直すこと → `test_fetch_cli.py`
- 置いた配布の読み方 → `test_jartic_regulation.py`
"""

import io
import zipfile

import pytest

from app.batch.common import read_fetch_record
from app.batch.fetch_cli import fetch_sources
from app.batch.source_adapters import abr, jartic_regulation
from app.infrastructure.source_models import Source
from tests.source_ingest import profile_within

#: 東京都（新宿区の代表点）だけに掛かる範囲（min_lat, min_lon, max_lat, max_lon）。
PROFILE = profile_within((35.68, 139.69, 35.70, 139.71))


def _archive(name: str, text: str, encoding: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(f"{name}/police_k_2.1.csv", text.encode(encoding))
    return buffer.getvalue()


@pytest.fixture
def city_positions(monkeypatch, tmp_path):
    """範囲に掛かる都道府県を東京都に決める ABR の市区町村の代表点。"""
    monkeypatch.setattr(abr, "DATA_DIR", tmp_path / "abr")
    monkeypatch.setattr(jartic_regulation, "DATA_DIR", tmp_path / "jartic")
    path = abr.archive_path("mt_city_pos_all")
    path.parent.mkdir(parents=True)
    path.write_bytes(_archive(path.stem, "lg_code,rep_lon,rep_lat\r\n131041,139.70,35.69\r\n", "utf-8"))


@pytest.mark.usefixtures("city_positions")
def test_places_the_prefecture_file_named_in_the_listing_and_records_its_version(respx_mock):
    """一覧の対応を使わないと、都道府県と違うファイルを取る。記録する版が取ったファイルの版と違うと、取り込んだ行の
    素性（`source_runs.origin`）が中身とずれる。"""
    link = "/202611010000/typeD_tokyo.zip"
    respx_mock.get(jartic_regulation.LISTING_URL).respond(json=[
        {"type": "typeA", "targetList": []},
        {"type": "typeD", "targetList": [{"id": "R13", "link": link}, {"id": "R14", "link": "/x/typeD_kanagawa.zip"}]},
    ])
    archive = _archive("typeD_tokyo", "ユニークキー,共通規制種別コード\r\n1,1\r\n", "cp932")
    respx_mock.get(jartic_regulation.FILES_URL + link).respond(content=archive)

    fetch_sources(PROFILE, [Source.JARTIC_REGULATION])

    assert jartic_regulation.archive_path("13").read_bytes() == archive
    assert read_fetch_record(jartic_regulation.DATA_DIR)["versions"] == {"13": "202611010000"}
