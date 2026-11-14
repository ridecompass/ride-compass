"""国土交通省の街区レベル位置参照情報（街区符号・地番ごとの代表点）のアダプタ。

**入力を上流から手元へ写すことと、外部の形を読んで1件ずつ返すことだけ**を行う。地番を住所の区画へ結ぶ・住居表示の区域の行をアドレス・ベース・レジストリに
譲るのは派生の段（`batch/derive_addresses.py`）である。

取得（`fetch_isj_blocks`）は配布元から、取込は手元から、配布の zip（都道府県ごと。中に Shift_JIS の CSV が1つと説明の
HTML・XML）を扱う。都道府県は、住所の生データと同じく取込の範囲に掛かる都道府県
（`source_adapters/abr.py: range_prefectures`。ABR の市区町村の代表点から決めるので、取得は ABR を取ったあとに流す）。
取得は都道府県ごとに、配布元の選ぶ画面が並べる街区レベルの版のうち最も新しいものを取り、都道府県ごとの版を置き場に記録する。

列は配布のまま（都道府県名・市区町村名・大字・丁目名・小字・通称名・街区符号・地番・緯度・経度・住居表示フラグ・
代表フラグ・更新前履歴フラグ・更新後履歴フラグ等）を全部`attrs`へ入れる。意味は配布の zip の中の説明（`<版>.html`）が持つ。
落とすのは次の行で、鍵は都道府県名から街区符号・地番までの名前をつないだもの。
- 代表フラグが 1 でない行（1つの街区符号・地番が複数の点を持つときの、代表でない点）
- 更新後履歴フラグが 3（削除）の行
- 点が取込の範囲（`target.bbox`）の外の行（都道府県の全部を入れると、範囲の外の地番で生データが膨らむ）

緯度・経度は日本測地系2011（EPSG:6668）で、ABR と同じく EPSG の変換で 4326 へ移す。
"""

import logging
import re
from collections.abc import AsyncIterator, Generator
from pathlib import Path
from typing import Any

import httpx
import shapely
from shapely.geometry import Point

from app.batch.common import fetch_once, fetch_timeout, read_fetch_record, write_fetch_record
from app.batch.ingest import Fetcher, SourceRecord, register_adapter
from app.batch.source_adapters.abr import JGD2011, RangeInputs, range_inputs, wgs84_transformer
from app.batch.source_adapters.zip_csv import read_zip_csv
from app.batch.source_profile import SourceProfile, SourceSpec
from app.infrastructure import data_paths

DATA_DIR = data_paths.DATA_DIR / "isj"

logger = logging.getLogger("ridecompass.ingest.isj_block")

_READ_TIMEOUT_SECONDS = 300.0

#: 配布元の取得の口（位置参照情報ダウンロードサービス。都道府県コード2桁に`000`をつないだ名前）。
DOWNLOAD_URL = "https://nlftp.mlit.go.jp/isj/dls/data/{version}/{prefecture}000-{version}.zip"
#: 配布元の選ぶ画面（都道府県 → 市区町村 → 配布の一覧）。応答は EUC-JP。
CITIES_URL = "https://nlftp.mlit.go.jp/cgi-bin/isj/dls/_view_cities_wards.cgi"
FILES_URL = "https://nlftp.mlit.go.jp/cgi-bin/isj/dls/_choose_files.cgi"
_PAGE_ENCODING = "euc-jp"
_PAGE_READ_TIMEOUT_SECONDS = 30.0
#: 街区レベルの版の名前（大字・町丁目レベルは末尾が`b`）。
_BLOCK_VERSION = re.compile(r">(\d+)\.(\d+)a<")
ENCODING = "cp932"
#: 鍵にする列（都道府県名から街区符号・地番まで）。
_KEY_COLUMNS = ("都道府県名", "市区町村名", "大字・丁目名", "小字・通称名", "街区符号・地番")
#: 更新後履歴フラグの「削除」。
_DELETED = "3"


def archive_path(prefecture: str) -> Path:
    """取り出した都道府県の配布の置き場。取得と取込で同じ導き方を使う。"""
    return DATA_DIR / f"{prefecture}000.zip"


def read_rows(path: Path) -> Generator[dict[str, str]]:
    """配布の zip の中の CSV（1つ）を、列の名前 → 値の行で流す。"""
    return read_zip_csv(path, ENCODING)


def isj_block_inputs(spec: SourceSpec, profile: SourceProfile) -> RangeInputs:
    return range_inputs(profile, archive_path)


def _page(url: str, form: dict[str, str]) -> str:
    response = httpx.post(url, data={"sbm": "1", **form}, timeout=fetch_timeout(_PAGE_READ_TIMEOUT_SECONDS))
    response.raise_for_status()
    return response.content.decode(_PAGE_ENCODING)


def latest_version(prefecture: str) -> str:
    """都道府県`prefecture`の全域の街区レベルの配布のうち、最も新しい版（例: `24.0a`）。"""
    whole = re.search(rf'value="(\d+)" name="ac" id="_ac{prefecture}000"', _page(CITIES_URL, {"pc": prefecture}))
    if whole is None:
        raise ValueError(f"配布元の画面に都道府県 {prefecture} の全域が無い")
    versions = _BLOCK_VERSION.findall(_page(FILES_URL, {"pc": prefecture, "ac": whole[1]}))
    if not versions:
        raise ValueError(f"配布元の画面に都道府県 {prefecture} の街区レベルの配布が無い")
    major, minor = max(versions, key=lambda version: (int(version[0]), int(version[1])))
    return f"{major}.{minor}a"


def fetch_isj_blocks(spec: SourceSpec, profile: SourceProfile) -> None:
    inputs = isj_block_inputs(spec, profile)
    logger.info("範囲に掛かる都道府県: %s", ", ".join(inputs.prefectures))
    versions = {}
    for code, path in zip(inputs.prefectures, inputs.archives, strict=True):
        versions[code] = latest_version(code)
        fetch_once(DOWNLOAD_URL.format(version=versions[code], prefecture=code), path,
                   read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)
    write_fetch_record(DATA_DIR, versions=versions)


@register_adapter("isj_block", inputs=isj_block_inputs,
                  fetcher=Fetcher(fetch_isj_blocks, lambda: (DATA_DIR,)))
async def read_isj_blocks(spec: SourceSpec, profile: SourceProfile, inputs: RangeInputs,
                          origin: dict[str, Any]) -> AsyncIterator[SourceRecord]:
    origin.update(read_fetch_record(DATA_DIR))
    transformer = wgs84_transformer(JGD2011)
    seen: set[str] = set()
    for path in inputs.archives:
        for row in read_rows(path):
            if row["代表フラグ"] != "1" or row["更新後履歴フラグ"] == _DELETED:
                continue
            lon, lat = transformer.transform(float(row["経度"]), float(row["緯度"]))
            key = "|".join(row[column] for column in _KEY_COLUMNS)
            if not profile.target.contains(lat, lon) or key in seen:
                continue
            seen.add(key)
            yield SourceRecord(natural_key=key, geom_wkb=shapely.to_wkb(Point(lon, lat)), attrs=row)
