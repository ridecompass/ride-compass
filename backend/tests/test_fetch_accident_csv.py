"""警察庁の本票CSVの取得（scripts/fetch_accident_csv.py）。

入口は`fetch`。実ダウンロード（60MB規模）はテストで行わず、配布元の応答と置き場だけを差し替えて、
「既にあるものは触らない」「読めないものを取得済みとして残さない」を確かめる。取得の道具が共有する手順
（`app/batch/common.py: place_verified`）の判断は、ここで見る（ほかの取得の道具のテストは寄せていることだけを見る）。
配布元へ応答を与えていない要求は`respx_mock`が落とすので、取りに行かないことは応答を与えないことで見る。

ここで見ないもの:
- 本票の列の読み方 → `test_npa_honhyo.py`
"""

import pytest

from app.batch.source_adapters import npa_honhyo
from app.batch.source_adapters.npa_honhyo import ENCODING
from scripts import fetch_accident_csv


def _honhyo_bytes() -> bytes:
    """本票として読める最小のCSV（見出し＋1行）。"""
    return "資料区分,都道府県コード,本票番号\n1,25,0001\n".encode(ENCODING)


URL_2024 = fetch_accident_csv.HONHYO_URL_TEMPLATE.format(year=2024)


@pytest.fixture
def distributor(monkeypatch, tmp_path, respx_mock):
    """配布元の代役（respx）と、置き場を`tmp_path`へ。応答はテストごとに経路を足して決める。"""
    monkeypatch.setattr(npa_honhyo, "DATA_DIR", tmp_path)
    return respx_mock


def test_joins_a_response_that_arrives_in_pieces(tmp_path, distributor):
    """大きなファイルは配布元から何度にも分けて届く。最初の塊で書くのを止めると、毎回欠けたものを取ることになる。"""
    whole = _honhyo_bytes()
    distributor.get(URL_2024).respond(content=iter([whole[:10], whole[10:]]))

    assert fetch_accident_csv.fetch([2024])

    assert (tmp_path / "honhyo_2024.csv").read_bytes() == whole


def test_keeps_existing_csv_untouched(tmp_path, distributor):
    destination = tmp_path / "honhyo_2024.csv"
    destination.write_bytes(_honhyo_bytes())

    assert fetch_accident_csv.fetch([2024])

    assert destination.read_bytes() == _honhyo_bytes()


def test_refetches_a_file_that_is_not_readable(tmp_path, distributor):
    """見出しだけ・空といった半端なものは「取得済み」と見なさない。"""
    destination = tmp_path / "honhyo_2024.csv"
    destination.write_bytes("資料区分,都道府県コード\n".encode(ENCODING))
    distributor.get(URL_2024).respond(content=_honhyo_bytes())

    assert fetch_accident_csv.fetch([2024])

    assert destination.read_bytes() == _honhyo_bytes()
