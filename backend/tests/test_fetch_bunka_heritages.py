"""国の文化財の建造物の取得（scripts/fetch_bunka_heritages.py）。

入口は`fetch`。配布元の応答（`respx_mock`）と置き場だけを差し替え、取り出した一覧の行の数が応答の件数に合うときだけ
取得済みとして置き、合わない一覧は消さずに退けることを確かめる。

ここで見ないもの:
- 一時ファイル経由の取得・読めるものを取り直さない・読めないものを退ける手順（`app/batch/common.py: place_verified`）
  → `test_fetch_accident_csv.py`
- 置いた一覧の項目の読み方 → `test_temple_stop_places.py`
"""

import json

import pytest

from app.batch.common import FETCH_BROKEN_SUFFIX
from app.batch.source_adapters import bunka_heritages
from scripts import fetch_bunka_heritages


@pytest.mark.parametrize(
    ("hit", "placed"),
    [
        pytest.param(1, True, id="件数に合う"),
        pytest.param(2, False, id="途中で打ち切られた"),
    ],
)
def test_places_the_list_only_when_it_has_every_hit(tmp_path, monkeypatch, respx_mock, hit, placed):
    """打ち切られた一覧を取得済みにすると、取込が欠けた文化財のまま進み、取り直されない。
    消すと、なぜ合わなかったかを中身で確かめられない。"""
    monkeypatch.setattr(bunka_heritages, "DATA_DIR", tmp_path)
    item = {"id": "bunka-1"}
    respx_mock.get(fetch_bunka_heritages.SCROLL_URL).respond(json={"list": [item], "hit": hit})

    assert fetch_bunka_heritages.fetch("2026-10-01") is placed

    destination = bunka_heritages.heritages_path("2026-10-01")
    assert destination.exists() is placed
    assert destination.with_name(destination.name + FETCH_BROKEN_SUFFIX).exists() is not placed
    if placed:
        assert json.loads(destination.read_text(encoding="utf-8")) == item
