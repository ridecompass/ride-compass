"""`batch/source_adapters/zip_csv.py`——配布の zip の中の CSV を読む。

入口は、取得の道具が置いたファイルを開いて確かめる`zip_csv_readable`。読めないものを読めないと答えないと、取得の道具は
それを退けて残りを取りに行く手順（`app/batch/common.py: place_verified`）へ進めず、例外で止まる。

ここで見ないもの:
- 行の読み方 → 読むアダプタのテスト（`test_npa_honhyo.py`等）
"""

import zipfile
from pathlib import Path

import pytest

from app.batch.source_adapters.zip_csv import zip_csv_readable

ENCODING = "cp932"


def _zip(path: Path, text: str) -> Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("data.csv", text.encode(ENCODING))
    return path


def _with_broken_compression(path: Path) -> Path:
    """圧縮された中身の頭を壊す（zip の目録は無傷で、展開して初めて分かる壊れ方）。"""
    _zip(path, "lg_code\n" + "".join(f"{i},abc{i * 7}\n" for i in range(50_000)))
    data = bytearray(path.read_bytes())
    for i in range(60, 400):
        data[i] ^= 0xFF
    path.write_bytes(bytes(data))
    return path


@pytest.mark.parametrize(("build", "readable"), [
    (lambda path: _zip(path, "lg_code,name\n131016,千代田区\n"), True),
    # 閉じない引用符で、1つの欄が CSV の読み手の上限を超える。
    (lambda path: _zip(path, 'lg_code\n"' + "x" * 200_000 + "\n"), False),
    (_with_broken_compression, False),
])
def test_answers_whether_the_csv_in_the_zip_can_be_read(tmp_path, build, readable):
    assert zip_csv_readable(build(tmp_path / "archive.zip"), ENCODING, "lg_code") is readable
