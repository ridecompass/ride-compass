"""日本道路交通情報センター（JARTIC）の交通規制情報（都道府県警察の交通規制データベースを拡張版標準フォーマットにしたもの）のアダプタ。

**入力を上流から手元へ写すことと、外部の形を読んで1件ずつ返すことだけ**を行う。規制を区間へ当てるのは派生の段である。

取得（`fetch_jartic_regulations`）は配布元から、取込は手元から、配布の zip（都道府県ごと。中に cp932 の CSV が1つ）を扱う。
都道府県は、住所の生データと同じく取込の範囲に掛かる都道府県（`source_adapters/abr.py: range_prefectures`。ABR の市区町村の
代表点から決めるので、取得は ABR を取ったあとに流す）。都道府県とファイルの対応は配布元の一覧（`LISTING_URL`）が持ち、手で表を
持たない。配布元は最新の版しか置かないので、取得は一覧が指す版を取り、都道府県ごとの版を置き場に記録する。

1つの規制を1行にし、鍵はユニークキー（全国で一意）、列は配布のまま全部を`attrs`へ入れる。列の意味は配布元の説明書
（拡張版標準フォーマット）が持つ。落とすのは、共通規制種別コードが宣言（`rows.kinds`）に無い規制と、形が取込の範囲
（`target.bbox`）の枠に掛からない規制。
"""

import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import shapely
from shapely.geometry import LineString, MultiPolygon, Polygon, box
from shapely.geometry.base import BaseGeometry

from app.batch.common import FetchError, fetch_file, fetch_timeout, read_fetch_record, write_fetch_record
from app.batch.ingest import Fetcher, SourceRecord, register_adapter
from app.batch.source_adapters.abr import RangeInputs, range_inputs
from app.batch.source_adapters.zip_csv import read_zip_csv
from app.batch.source_profile import SourceProfile, SourceSpec
from app.infrastructure import data_paths

DATA_DIR = data_paths.DATA_DIR / "jartic"

logger = logging.getLogger("ridecompass.ingest.jartic_regulation")

#: 配布の一覧。交通規制情報は`type`が`typeD`の要素で、`targetList`の`id`は`R`＋JIS の都道府県コード2桁、`link`は
#: `/<版>/<ファイル名>`（`FILES_URL`からの道）。
LISTING_URL = "https://www.jartic.or.jp/d/opendata/opendata.json"
FILES_URL = "https://www.jartic.or.jp/d/opendata"
_REGULATIONS_TYPE = "typeD"

_LISTING_READ_TIMEOUT_SECONDS = 30.0
_READ_TIMEOUT_SECONDS = 300.0

ENCODING = "cp932"
#: 規制の鍵（全国で一意）。
_KEY_COLUMN = "ユニークキー"
#: 点・線・面コードの線と面。
_LINE = "2"
_AREA = "3"


@dataclass(frozen=True)
class JarticRegulationRows:
    """`jartic_regulation`の`rows`。"""

    #: 取り込む共通規制種別コード（例: 歩行者用道路は`1`）。
    kinds: list[str]


def archive_path(prefecture: str) -> Path:
    """取り出した都道府県（JIS の2桁）の配布の置き場。取得と取込で同じ導き方を使う。"""
    return DATA_DIR / f"{prefecture}.zip"


def jartic_regulation_inputs(spec: SourceSpec, profile: SourceProfile) -> RangeInputs:
    return range_inputs(profile, archive_path)


def _regulation_shape(kind: str, coordinates: str) -> BaseGeometry:
    """点・線・面コード`kind`と規制場所の経度緯度（`経度 緯度;経度 緯度;…`）から形を作る。

    配布の面には自分と交わる多角形があり、そのままでは空間の演算が例外になるので、面に直して面の部分だけを残す。
    線・面でない形と、形にならない座標は`ValueError`。
    """
    points = [tuple(float(value) for value in point.split()) for point in coordinates.split(";")]
    if kind == _LINE:
        return LineString(points)
    if kind != _AREA:
        raise ValueError(f"線でも面でもない点・線・面コード: {kind!r}")
    polygon = Polygon(points)
    if polygon.is_valid:
        return polygon
    # 直した形は、面と、潰れた辺の線が混ざった集まりになる。
    areas = [part for part in shapely.get_parts(shapely.make_valid(polygon)) if isinstance(part, (Polygon, MultiPolygon))]
    if not areas:
        raise ValueError("面に直すと面が残らない")
    return areas[0] if len(areas) == 1 else MultiPolygon([p for area in areas for p in shapely.get_parts(area)])


def _listed_links() -> dict[str, str]:
    """一覧の交通規制情報の、都道府県コード（2桁）→ ファイルへの道。"""
    response = httpx.get(LISTING_URL, timeout=fetch_timeout(_LISTING_READ_TIMEOUT_SECONDS), follow_redirects=True)
    response.raise_for_status()
    [entry] = [item for item in response.json() if item["type"] == _REGULATIONS_TYPE]
    return {target["id"].removeprefix("R"): target["link"] for target in entry["targetList"]}


def fetch_jartic_regulations(spec: SourceSpec, profile: SourceProfile) -> None:
    inputs = jartic_regulation_inputs(spec, profile)
    logger.info("範囲に掛かる都道府県: %s", ", ".join(inputs.prefectures))
    links = _listed_links()
    unlisted = [code for code in inputs.prefectures if code not in links]
    if unlisted:
        raise FetchError(f"配布の一覧に無い都道府県: {', '.join(unlisted)}")
    for code, path in zip(inputs.prefectures, inputs.archives, strict=True):
        fetch_file(FILES_URL + links[code], path, read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)
    write_fetch_record(DATA_DIR, versions={code: links[code].split("/")[1] for code in inputs.prefectures})


@register_adapter("jartic_regulation", rows=JarticRegulationRows, inputs=jartic_regulation_inputs,
                  fetcher=Fetcher(fetch_jartic_regulations, lambda: (DATA_DIR,)))
async def read_jartic_regulations(spec: SourceSpec, profile: SourceProfile, inputs: RangeInputs,
                                  origin: dict[str, Any]) -> AsyncIterator[SourceRecord]:
    rows: JarticRegulationRows = spec.rows
    origin.update(read_fetch_record(DATA_DIR))
    kinds = set(rows.kinds)
    min_lat, min_lon, max_lat, max_lon = profile.target.bbox
    frame = box(min_lon, min_lat, max_lon, max_lat)
    for path in inputs.archives:
        for row in read_zip_csv(path, ENCODING):
            if row["共通規制種別コード"] not in kinds:
                continue
            try:
                geometry = _regulation_shape(row["点・線・面コード"], row["規制場所の経度緯度"])
            except ValueError as exc:
                raise ValueError(f"JARTIC の交通規制の形が読めない: {path} {row[_KEY_COLUMN]}") from exc
            if geometry.intersects(frame):
                yield SourceRecord(natural_key=row[_KEY_COLUMN], geom_wkb=shapely.to_wkb(geometry), attrs=row)
