"""e-Stat の小地域（国勢調査の町丁・字等）の境界のアダプタ。

**入力を上流から手元へ写すことと、外部の形を読んで1件ずつ返すことだけ**を行う。境界を住所の区画へ結ぶのは派生の段（`batch/derive_addresses.py`）である。

取得（`fetch_estat_small_areas`）は配布元から、取込は手元から、配布の zip（都道府県ごとの Shapefile。座標は日本測地系2011
（EPSG:6668）の経緯度、dbf は CP932）を扱う。都道府県は、住所の生データと同じく取込の範囲に掛かる都道府県
（`source_adapters/abr.py: range_prefectures`。ABR の市区町村の代表点から決めるので、取得は ABR を取ったあとに流す）。
取得は配布元が置く国勢調査の小地域の境界のうち最も新しい年のものを取り、その統計調査の識別子を置き場に記録する。

1つの小地域が離れた島・飛び地で何枚かの多角形に分かれて入っているので、小地域のコード（都道府県2桁＋市区町村3桁＋
町丁・字等6桁）ごとに1つの多角形にまとめ、それを鍵にする（配布の`KEY_CODE`は名前の無い小地域で桁が欠ける）。属性は
最も広い1枚（`AREA_MAX_F`の印）の dbf の列を全部`attrs`へ入れる。落とすのは通常の小地域（`HCODE` 8101）でない行
（水面の 8154 等）。
"""

import io
import logging
import re
import zipfile
from collections import defaultdict
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pyproj
import shapefile
import shapely
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

from app.batch.common import fetch_once, fetch_timeout, read_fetch_record, write_fetch_record
from app.batch.ingest import Fetcher, SourceRecord, register_adapter
from app.batch.source_adapters.abr import JGD2011, RangeInputs, range_inputs, wgs84_transformer
from app.batch.source_profile import SourceProfile, SourceSpec
from app.infrastructure import data_paths

DATA_DIR = data_paths.DATA_DIR / "estat"

logger = logging.getLogger("ridecompass.ingest.estat_small_area")

_READ_TIMEOUT_SECONDS = 300.0

#: 通常の小地域の境界の区分（`HCODE`）。
NORMAL_AREA_HCODE = 8101
#: 配布元の境界データの一覧の口（画面の裏で JSON を返す）。`detail`の HTML に統計調査の識別子が並ぶ。
SURVEYS_URL = ("https://www.e-stat.go.jp/gis/statmap-search/search_detail?page=1&type=2"
               "&aggregateUnitForBoundary=A&toukeiCode=00200521")
#: 国勢調査の小地域の境界の統計調査の識別子（`dlserveyId`）。末尾の4桁が調査の年。
_SMALL_AREA_SURVEY = re.compile(r"serveyId=(A00200521\d{4})")
_SURVEYS_READ_TIMEOUT_SECONDS = 30.0
#: 配布元の取得の口（統計地理情報システムの境界データ。Shapefile・経緯度・日本測地系2011）。
DOWNLOAD_URL = ("https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId={survey}&code={prefecture}"
                "&coordSys=1&format=shape&downloadType=5&datum=2011")
_ENCODING = "cp932"
#: 最も広い1枚に付く印（`AREA_MAX_F`）。
_LARGEST_PART = "M"


def boundary_path(prefecture: str) -> Path:
    """取り出した都道府県の境界の置き場。取得と取込で同じ導き方を使う。"""
    return DATA_DIR / f"{prefecture}.zip"


def estat_small_area_inputs(spec: SourceSpec, profile: SourceProfile) -> RangeInputs:
    return range_inputs(profile, boundary_path)


def latest_survey() -> str:
    """配布元が置く国勢調査の小地域の境界のうち、最も新しい年の統計調査の識別子（例: `A002005212020`）。"""
    response = httpx.get(SURVEYS_URL, timeout=fetch_timeout(_SURVEYS_READ_TIMEOUT_SECONDS), follow_redirects=True)
    response.raise_for_status()
    surveys = _SMALL_AREA_SURVEY.findall(response.json()["detail"])
    if not surveys:
        raise ValueError("配布元の一覧に国勢調査の小地域の境界が無い")
    return max(surveys)


def _to_wgs84(geometry: BaseGeometry, transformer: pyproj.Transformer) -> BaseGeometry:
    def move(coordinates: np.ndarray) -> np.ndarray:
        lon, lat = transformer.transform(coordinates[:, 0], coordinates[:, 1])
        return np.column_stack([lon, lat])

    return shapely.transform(geometry, move)


def _read_prefecture(path: Path, transformer: pyproj.Transformer) -> list[SourceRecord]:
    parts: dict[str, list[BaseGeometry]] = defaultdict(list)
    attrs: dict[str, dict[str, Any]] = {}
    with zipfile.ZipFile(path) as archive:
        members = {Path(name).suffix.lower(): name for name in archive.namelist()}
        reader = shapefile.Reader(shp=io.BytesIO(archive.read(members[".shp"])),
                                  shx=io.BytesIO(archive.read(members[".shx"])),
                                  dbf=io.BytesIO(archive.read(members[".dbf"])), encoding=_ENCODING)
        for item in reader.iterShapeRecords():
            record = item.record.as_dict()
            if record["HCODE"] != NORMAL_AREA_HCODE:
                continue
            key = f"{record['PREF']}{record['CITY']}{record['S_AREA']}"
            parts[key].append(shape(item.shape.__geo_interface__))
            if key not in attrs or record["AREA_MAX_F"] == _LARGEST_PART:
                attrs[key] = record
    records = []
    for key, polygons in parts.items():
        merged = polygons[0] if len(polygons) == 1 else shapely.union_all(polygons)
        records.append(SourceRecord(natural_key=key, geom_wkb=shapely.to_wkb(_to_wgs84(merged, transformer)),
                                    attrs=attrs[key]))
    return records


def fetch_estat_small_areas(spec: SourceSpec, profile: SourceProfile) -> None:
    survey = latest_survey()
    inputs = estat_small_area_inputs(spec, profile)
    logger.info("統計調査 %s の範囲に掛かる都道府県: %s", survey, ", ".join(inputs.prefectures))
    for code, path in zip(inputs.prefectures, inputs.archives, strict=True):
        fetch_once(DOWNLOAD_URL.format(survey=survey, prefecture=code), path,
                   read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)
    write_fetch_record(DATA_DIR, survey=survey)


@register_adapter("estat_small_area", inputs=estat_small_area_inputs,
                  fetcher=Fetcher(fetch_estat_small_areas, lambda: (DATA_DIR,)))
async def read_estat_small_areas(spec: SourceSpec, profile: SourceProfile, inputs: RangeInputs,
                                 origin: dict[str, Any]) -> AsyncIterator[SourceRecord]:
    origin.update(read_fetch_record(DATA_DIR))
    transformer = wgs84_transformer(JGD2011)
    for path in inputs.archives:
        for record in _read_prefecture(path, transformer):
            yield record
