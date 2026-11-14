"""Overture Maps の地点（places の GeoParquet）のアダプタ。

**入力を上流から手元へ写すことと、外部の形を読んで1件ずつ返すことだけ**を行う。群へ入れる・近くの同じ店をまとめるのは派生の段
（`batch/derive_places.py`）で、ここは取り込む母集団の外の地点を落とすだけである。

取得（`fetch_overture_places`）は、全世界ぶんを AWS S3 に置いた版ごとの GeoParquet から、DuckDB で取込の範囲（`target.bbox`）の
地点だけを読み、列は全部のまま1つの Parquet へ書く（公式の文書「DuckDB」の読み方。S3 は認証なしで読める）。取込は手元にあるものを読む。

落とすのは次の地点:
- 取込の範囲（`target.bbox`）の外
- 確からしさ（`confidence`）が宣言（`rows.min_confidence`）より低い。閉じた地点は0になる
- 名前が無い（地図にも検索にも出せない）

残した地点の列は、位置（`geometry`・`bbox`）を除いて全部`attrs`へ入れる。
"""

import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb

from app.batch.common import place_once
from app.batch.ingest import AdapterInputs, Fetcher, SourceRecord, register_adapter
from app.batch.source_profile import SourceProfile, SourceSpec
from app.infrastructure import data_paths

DATA_DIR = data_paths.DATA_DIR / "overture"

logger = logging.getLogger("ridecompass.ingest.overture_places")

#: 配布の置き場。版ごとに1つ。
PLACES_URL_TEMPLATE = "s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*"
_S3_REGION = "us-west-2"

#: 1回に読み出す行の数。DuckDBから溜めずに流すための区切り。
_FETCH_ROWS = 10_000

_SELECT_SQL = """
-- 位置の列は`geom`へ入れるので属性から除く（マージパッチの null はそのキーを消す。RFC 7386）。
SELECT p.id, ST_AsWKB(p.geometry), json_merge_patch(to_json(p), '{"geometry": null, "bbox": null}')
FROM read_parquet(?) p
WHERE p.bbox.xmin BETWEEN ? AND ? AND p.bbox.ymin BETWEEN ? AND ?
  AND p.confidence >= ?
  AND p.names.primary IS NOT NULL
"""


@dataclass(frozen=True)
class OverturePlaceRows:
    """`overture_places`の`rows`。"""

    #: 配布の版（例: `2026-09-23.1`）。版ごとに配布の置き場が分かれる。
    release: str
    #: これより確からしさの低い地点は取り込まない。
    min_confidence: float


def places_path(release: str) -> Path:
    """取り出した地点の置き場。取得と取込で同じ導き方を使う。"""
    return DATA_DIR / f"places_{release}.parquet"


def overture_places_inputs(spec: SourceSpec, profile: SourceProfile) -> AdapterInputs:
    return AdapterInputs(files=(places_path(spec.rows.release),))


def fetch_overture_places(spec: SourceSpec, profile: SourceProfile) -> None:
    """範囲の地点を書く。"""
    url = PLACES_URL_TEMPLATE.format(release=spec.rows.release)
    min_lat, min_lon, max_lat, max_lon = profile.target.bbox

    def write(temporary: Path) -> None:
        with duckdb.connect() as conn:
            conn.execute(f"SET s3_region = '{_S3_REGION}'")
            # `hive_partitioning`は置き場のパスの`theme=`・`type=`を列にする。
            conn.execute(
                "COPY (SELECT * FROM read_parquet(?, hive_partitioning = true)"
                " WHERE bbox.xmin BETWEEN ? AND ? AND bbox.ymin BETWEEN ? AND ?)"
                f" TO '{temporary}' (FORMAT parquet)",
                [url, min_lon, max_lon, min_lat, max_lat])

    place_once(places_path(spec.rows.release), write, source=url, logger=logger)


@register_adapter("overture_places", rows=OverturePlaceRows, inputs=overture_places_inputs,
                  fetcher=Fetcher(fetch_overture_places, lambda: (DATA_DIR,)))
async def read_overture_places(spec: SourceSpec, profile: SourceProfile, inputs: AdapterInputs,
                               origin: dict[str, Any]) -> AsyncIterator[SourceRecord]:
    rows: OverturePlaceRows = spec.rows
    (path,) = inputs.files
    origin["release"] = rows.release
    min_lat, min_lon, max_lat, max_lon = profile.target.bbox
    # 点の`bbox`の最小は点そのもの（公式の文書「DuckDB」の Overture の読み方）。
    with duckdb.connect() as conn:
        conn.execute(_SELECT_SQL, [str(path), min_lon, max_lon, min_lat, max_lat, rows.min_confidence])
        while batch := conn.fetchmany(_FETCH_ROWS):
            for place_id, wkb, attrs in batch:
                yield SourceRecord(natural_key=place_id, geom_wkb=bytes(wkb), attrs=json.loads(attrs))
