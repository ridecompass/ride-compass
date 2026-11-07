"""配布の zip の中の CSV（1つ）を読む。

文字コードは配布元ごとに違うので、呼び手が渡す。
"""

import csv
import io
import zipfile
import zlib
from collections.abc import Generator
from pathlib import Path


def read_zip_csv(path: Path, encoding: str) -> Generator[dict[str, str]]:
    """zip の中の CSV（1つ）を、列の名前 → 値の行で流す。CSV でない付属のファイル（説明の HTML 等）は読まない。"""
    with zipfile.ZipFile(path) as archive:
        [member] = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        with archive.open(member) as raw:
            yield from csv.DictReader(io.TextIOWrapper(raw, encoding=encoding, newline=""))


def zip_csv_readable(path: Path, encoding: str, column: str) -> bool:
    """CSV を1つ持つ zip で、見出しに`column`があり、1行以上あるか。"""
    try:
        rows = read_zip_csv(path, encoding)
        first = next(rows, None)
        rows.close()
        return first is not None and column in first
    except (OSError, ValueError, zipfile.BadZipFile, zlib.error, UnicodeDecodeError, csv.Error):
        return False
