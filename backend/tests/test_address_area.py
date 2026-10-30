"""`domain/address_area.py`——住所の表記の揃え方（`standardize_address`）。

打った入力と区画の鍵の両方に同じ揃え方をかけるので、書き方の違う同じ住所が同じ文字列になることを見る。

地番の名前を区画へ当てる鍵の順（`parcel_name_candidates`）も見る。

ここで見ないもの:
- 区画の名前から作る鍵の別形（書き始める段・郡を省いた形・字の有無）→ `test_address_areas.py`（派生の段を通して見る）
"""

import pytest

from app.domain.address_area import chome_name, parcel_name_candidates, standardize_address


@pytest.mark.parametrize(("typed", "listed"), [
    # ハイフンと長音の類
    ("西新宿2ー8―1", "西新宿2-8-1"),
    # 漢数字（「十」を含む）
    ("本町十二丁目", "本町12丁目"),
    ("本町二十三", "本町23"),
    # 数字の後の「丁」は区切り
    ("本町3丁", "本町3-"),
    # 「大字」は書いても書かなくてもよい
    ("大字奈良井", "奈良井"),
    # 「ヶ」「ヵ」「ケ」「が」
    ("霞ヵ関", "霞が関"),
    # 「の」「之」「ノ」
    ("北の丸公園", "北ノ丸公園"),
    # 全角・大文字
    ("ＡＢＣ町", "abc町"),
], ids=lambda value: value)
def test_書き方の違う同じ住所は同じ形に揃う(typed, listed):
    assert standardize_address(typed) == standardize_address(listed)


def test_揃えた形は丁目を区切りにし番地をそのまま続ける():
    """丁目の鍵（「西新宿2-」）を頭に持つ形になり、番地まで打った入力でも丁目までの鍵が頭に当たる。"""
    assert standardize_address("東京都 新宿区 西新宿二丁目八番一号") == "東京都新宿区西新宿2-8番1号"


@pytest.mark.parametrize(("number", "written", "name"), [
    ("4", "４丁目", "四丁目"),
    ("10", "１０丁目", "十丁目"),
    ("42", "４２丁目", "四十二丁目"),
    ("6", "６丁", "六丁"),
])
def test_丁目の名前は番号から漢数字でそろえる(number, written, name):
    """ABR の丁目の表記（全角の算用数字・漢数字・「丁」）が混ざっても、区画の名前は漢数字の同じ見た目になり、鍵も変わらない。"""
    assert chome_name(number, written) == name
    assert standardize_address(name) == standardize_address(written)


def test_地番の名前は同じ名前の区画から頭とお尻の長い区画の順に当てる():
    """頭の短い区画（「上大」）を先に当てると、より細かい区画（「上大塚」）がある地番が粗い区画に結ばれる。括弧の中は名前に数えない。"""
    assert parcel_name_candidates("上大塚西（大字なし）") == ["上大塚西", "上大塚", "上大", "大塚西", "塚西"]
