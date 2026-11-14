"""警察庁 交通事故統計オープンデータ（本票CSV）のアダプタ。

**入力を上流から手元へ写すことと、外部の形を読んで1件ずつ返すことだけ**を行う。ステージング・差し替え・run記録は
`ingest.py`の共通経路が持つ。

取得（`fetch_honhyo`）は配布元が一覧に載せる全部の年の本票CSVを手元へ写し、取った年を置き場に記録する。
取込は記録の年の本票CSVを手元から読む。

列は捨てずに全部`attrs`へ入れる。何が後で要るかは取込の時点では決められない——
2022年に列構成が58列から68列へ変わっており、そのとき何を拾うべきだったかは
後から見ないと分からない。

絞りはbboxで行う。行政区画で絞るには警察庁独自の採番とJIS X 0401の対応表が要るが、
母集団の指定としてはbboxで足りる。
"""

import csv
import logging
import re
from collections.abc import AsyncIterator
from typing import Any
from pathlib import Path

import httpx
import shapely
from shapely.geometry import Point

from app.batch.common import fetch_once, fetch_timeout, read_fetch_record, write_fetch_record
from app.batch.ingest import AdapterInputs, Fetcher, SourceRecord, register_adapter
from app.batch.source_profile import SourceProfile, SourceSpec
from app.infrastructure import data_paths

logger = logging.getLogger("ridecompass.ingest.npa_honhyo")

DATA_DIR = data_paths.DATA_DIR / "accidents"

#: 配布元の一覧のページ。年ごとのページ（`opendata/<年>/opendata_<年>.html`）へのリンクが並ぶ。
LISTING_URL = "https://www.npa.go.jp/publications/statistics/koutsuu/opendata/index_opendata.html"
_LISTED_YEAR = re.compile(r"opendata/(\d{4})/opendata_\d{4}\.html")
_LISTING_READ_TIMEOUT_SECONDS = 30.0
#: 配布元。年ごとに1ファイル。
HONHYO_URL_TEMPLATE = (
    "https://www.npa.go.jp/publications/statistics/koutsuu/opendata/{year}/honhyo_{year}.csv")

_READ_TIMEOUT_SECONDS = 120.0

#: 本票CSVの文字コード。
ENCODING = "cp932"

#: 緯度・経度の列名（度分秒をつないだ数字列で入っている）。
_LAT_HEADER = "地点　緯度（北緯）"
_LON_HEADER = "地点　経度（東経）"


def _dms_to_decimal(raw: str) -> float | None:
    """本票の緯度・経度列（度分秒を1つの数値へ連結した表記。右5桁=秒×1000、
    次の2桁=分、残り=度）を10進の度へ変換する。欠損（空・非数値）や
    分/秒が60以上になる不正値はNone（根拠のない推測はしない）。

    全て0の列は0度として通す。日本の範囲外として落とすのは`latitude_from_raw`／
    `longitude_from_raw`の側で、ここは表記の解釈だけを負う。"""
    value = raw.strip()
    if not value.isdigit() or len(value) < 8:
        return None
    seconds = int(value[-5:]) / 1000.0
    minutes = int(value[-7:-5])
    degrees = int(value[:-7])
    if minutes >= 60 or seconds >= 60:
        return None
    return degrees + minutes / 60.0 + seconds / 3600.0


# 日本の緯度・経度のおおよその範囲（南鳥島・沖ノ鳥島等の離島を含む広めの値）。
# 度分秒からの変換結果が壊れていないかを見るためだけのもので、対象地域の絞り込みではない。
_JAPAN_LATITUDE_RANGE = (20.0, 46.0)
_JAPAN_LONGITUDE_RANGE = (122.0, 154.0)


def latitude_from_raw(raw: str) -> float | None:
    value = _dms_to_decimal(raw)
    if value is None or not (_JAPAN_LATITUDE_RANGE[0] <= value <= _JAPAN_LATITUDE_RANGE[1]):
        return None
    return value


def longitude_from_raw(raw: str) -> float | None:
    value = _dms_to_decimal(raw)
    if value is None or not (_JAPAN_LONGITUDE_RANGE[0] <= value <= _JAPAN_LONGITUDE_RANGE[1]):
        return None
    return value


def honhyo_path(year: int) -> Path:
    """本票CSVの置き場。取得と取込で同じ導き方を使う。"""
    return DATA_DIR / f"honhyo_{year}.csv"


def listed_years() -> list[int]:
    """配布元の一覧のページが載せる年（古い順）。"""
    response = httpx.get(LISTING_URL, timeout=fetch_timeout(_LISTING_READ_TIMEOUT_SECONDS), follow_redirects=True)
    response.raise_for_status()
    years = sorted({int(year) for year in _LISTED_YEAR.findall(response.text)})
    if not years:
        raise ValueError("配布元の一覧に年が無い")
    return years


def npa_honhyo_inputs(spec: SourceSpec, profile: SourceProfile) -> AdapterInputs:
    return AdapterInputs(files=tuple(honhyo_path(year) for year in read_fetch_record(DATA_DIR)["years"]))


def fetch_honhyo(spec: SourceSpec, profile: SourceProfile) -> None:
    years = listed_years()
    for year in years:
        fetch_once(HONHYO_URL_TEMPLATE.format(year=year), honhyo_path(year),
                   read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)
    write_fetch_record(DATA_DIR, years=years)


@register_adapter("npa_honhyo", inputs=npa_honhyo_inputs,
                  fetcher=Fetcher(fetch_honhyo, lambda: (DATA_DIR,)))
async def read_npa_honhyo(spec: SourceSpec, profile: SourceProfile, inputs: AdapterInputs,
                          origin: dict[str, Any]) -> AsyncIterator[SourceRecord]:
    target = profile.target
    record = read_fetch_record(DATA_DIR)
    origin.update(record)
    skipped = 0
    for year, path in zip(record["years"], inputs.files, strict=True):
        with open(path, encoding=ENCODING, newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                lat = latitude_from_raw(row.get(_LAT_HEADER, ""))
                lon = longitude_from_raw(row.get(_LON_HEADER, ""))
                if lat is None or lon is None:
                    skipped += 1
                    continue
                if not target.contains(lat, lon):
                    continue
                natural_key = "-".join((
                    str(year),
                    row.get("都道府県コード", ""),
                    row.get("警察署等コード", ""),
                    row.get("本票番号", ""),
                ))
                yield SourceRecord(
                    natural_key=natural_key,
                    geom_wkb=shapely.to_wkb(Point(lon, lat)),
                    attrs={k: v for k, v in row.items() if k},
                )
    if skipped:
        logger.warning("座標が読めずスキップした行: %d件", skipped)
