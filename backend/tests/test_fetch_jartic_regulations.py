"""JARTIC の交通規制情報の取得（scripts/fetch_jartic_regulations.py）。

入口は`fetch`。配布元の応答（`respx_mock`）と置き場だけを差し替え、都道府県のファイルを一覧の対応から引いて置くことと、
一覧の版が宣言の版と違えば取らずに止まることを確かめる。

ここで見ないもの:
- 一時ファイル経由の取得・読めるものを取り直さない・読めないものを退ける手順（`app/batch/common.py: place_verified`）
  → `test_fetch_accident_csv.py`
- 置いた配布の読み方 → `test_jartic_regulation.py`
"""

import io
import zipfile

import pytest

from app.batch.source_adapters import jartic_regulation
from scripts import fetch_jartic_regulations

VERSION = "202611010000"


def _archive() -> bytes:
    """配布の形の zip（cp932 の CSV が1つ）。"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("typeD_tokyo/police_k_2.1.csv", "ユニークキー,共通規制種別コード\r\n1,1\r\n".encode("cp932"))
    return buffer.getvalue()


@pytest.mark.parametrize(
    ("listed_version", "placed"),
    [
        pytest.param(VERSION, True, id="一覧の版が宣言と同じ"),
        pytest.param("202612010000", False, id="配布元が次の版へ進んだ"),
    ],
)
def test_places_the_prefecture_file_named_in_the_listing_only_for_the_declared_version(
        tmp_path, monkeypatch, respx_mock, listed_version, placed):
    """宣言と違う版を取って宣言の版の置き場へ置くと、取込が記録する版と中身がずれる。
    一覧の対応を使わないと、都道府県と違うファイルを取る。"""
    monkeypatch.setattr(jartic_regulation, "DATA_DIR", tmp_path)
    link = f"/{listed_version}/typeD_tokyo.zip"
    respx_mock.get(fetch_jartic_regulations.LISTING_URL).respond(json=[
        {"type": "typeA", "targetList": []},
        {"type": "typeD", "targetList": [{"id": "R13", "link": link}, {"id": "R14", "link": "/x/typeD_kanagawa.zip"}]},
    ])
    respx_mock.get(fetch_jartic_regulations.FILES_URL + link).respond(content=_archive())

    assert fetch_jartic_regulations.fetch(VERSION, ["13"]) is placed

    assert jartic_regulation.archive_path(VERSION, "13").exists() is placed
