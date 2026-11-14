"""国の指定・登録の文化財の建造物（文化遺産オンラインの項目をジャパンサーチの API で取ったもの）のアダプタ。

**入力を上流から手元へ写すことと、外部の形を読んで1件ずつ返すことだけ**を行う。寺社かの判断と、同じ寺社の建物を1つにまとめるのは派生の段
（`batch/derive_places.py`）で、ここは取り込む母集団の外の行を落とすだけである。

取得（`fetch_bunka_heritages`）は**全国を取る**（取込の範囲は取込が絞るので、範囲を広げても取り直さない）。口は全件取得
（scroll）で、1回目に検索の条件を、2回目からは応答の`scrollId`を渡し、`scrollId`の無い応答で終わる（公式の「簡易Web APIガイド」
4.2.2。検索の口の`from`・`size`は2,000件で止まる）。配信元は間を空けて打つよう求め、上限の目安を示さないので、1回ごとに
`_REQUEST_INTERVAL_SECONDS`待つ（同じガイドの1.4）。配信元は版を持たず今の一覧だけを返すので、取った時刻を置き場に記録する。
取込は手元にあるもの（全国の建造物の項目を1行1件の JSON で並べたファイル）を読む。

落とすのは次の行:
- 位置が無い
- 取込の範囲（`target.bbox`）の外
- 指定の別（`bunka-11-s`）が宣言（`rows.designations`）に無い——建造物の項目には、史跡・美術品・世界遺産の構成資産等の
  建物でない指定も混ざる

残した行の項目は全部`attrs`へ入れる。
"""

import json
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import shapely
from shapely.geometry import Point

from app.batch.common import fetch_timeout, place_once, read_fetch_record, write_fetch_record
from app.batch.ingest import AdapterInputs, Fetcher, SourceRecord, register_adapter
from app.batch.source_profile import SourceProfile, SourceSpec
from app.infrastructure import data_paths

DATA_DIR = data_paths.DATA_DIR / "bunka"

logger = logging.getLogger("ridecompass.ingest.bunka_heritages")

#: 全件取得の口。
SCROLL_URL = "https://jpsearch.go.jp/api/item/scroll/jps-cross"
#: 文化遺産オンラインの項目のうち、種類が建造物のもの。
SEARCH_PARAMS = {"f-db": "bunka", "f-type": "architecture"}

_REQUEST_INTERVAL_SECONDS = 1.0
_READ_TIMEOUT_SECONDS = 120.0

#: 指定の別の項目。
DESIGNATION_FIELD = "bunka-11-s"


@dataclass(frozen=True)
class BunkaHeritageRows:
    """`bunka_heritages`の`rows`。"""

    #: 取り込む指定の別（文化遺産オンラインの表記のまま）。
    designations: list[str]


def heritages_path() -> Path:
    """取り出した項目の置き場。取得と取込で同じ導き方を使う。"""
    return DATA_DIR / "architecture.jsonl"


def bunka_heritages_inputs(spec: SourceSpec, profile: SourceProfile) -> AdapterInputs:
    return AdapterInputs(files=(heritages_path(),))


def _write_heritages(temporary: Path) -> None:
    """全件を1行1件で書く。"""
    written = 0
    params: dict[str, str] = SEARCH_PARAMS
    with httpx.Client(timeout=fetch_timeout(_READ_TIMEOUT_SECONDS)) as client, \
            temporary.open("w", encoding="utf-8") as sink:
        while True:
            response = client.get(SCROLL_URL, params=params)
            response.raise_for_status()
            page = response.json()
            for item in page["list"]:
                sink.write(json.dumps(item, ensure_ascii=False) + "\n")
            written += len(page["list"])
            logger.info("取得中 %d / %d件", written, page["hit"])
            if "scrollId" not in page or not page["list"]:
                break
            params = {"scrollId": page["scrollId"]}
            time.sleep(_REQUEST_INTERVAL_SECONDS)


def fetch_bunka_heritages(spec: SourceSpec, profile: SourceProfile) -> None:
    place_once(heritages_path(), _write_heritages, source=SCROLL_URL, logger=logger)
    write_fetch_record(DATA_DIR)


@register_adapter("bunka_heritages", rows=BunkaHeritageRows, inputs=bunka_heritages_inputs,
                  fetcher=Fetcher(fetch_bunka_heritages, lambda: (DATA_DIR,)))
async def read_bunka_heritages(spec: SourceSpec, profile: SourceProfile, inputs: AdapterInputs,
                               origin: dict[str, Any]) -> AsyncIterator[SourceRecord]:
    rows: BunkaHeritageRows = spec.rows
    (path,) = inputs.files
    origin.update(read_fetch_record(DATA_DIR))
    designations = set(rows.designations)
    with path.open(encoding="utf-8") as lines:
        for line in lines:
            item = json.loads(line)
            coordinates = item["common"].get("coordinates")
            if coordinates is None or item.get(DESIGNATION_FIELD) not in designations:
                continue
            lat, lon = coordinates["lat"], coordinates["lon"]
            if not profile.target.contains(lat, lon):
                continue
            yield SourceRecord(natural_key=item["id"], geom_wkb=shapely.to_wkb(Point(lon, lat)), attrs=item)
