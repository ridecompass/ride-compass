"""日本道路交通情報センター（JARTIC）の交通規制情報（都道府県警察の交通規制データベースを拡張版標準フォーマットにしたもの）のアダプタ。

**外部の形を読んで1件ずつ返すことだけ**を行う。規制を区間へ当てるのは派生の段である。

**配信元は叩かない。** 取りに行くのは`scripts/fetch_jartic_regulations.py`の仕事で、ここは手元の配布の zip（都道府県ごと。中に
cp932 の CSV が1つ）を読む。読む都道府県は、住所の生データと同じく取込の範囲に掛かる都道府県
（`source_adapters/abr.py: range_prefectures`。ABR の市区町村の代表点から決める）。

1つの規制を1行にし、鍵はユニークキー（全国で一意）、列は配布のまま全部を`attrs`へ入れる。列の意味は配布元の説明書
（拡張版標準フォーマット）が持つ。落とすのは、共通規制種別コードが宣言（`rows.kinds`）に無い規制と、形が取込の範囲
（`target.bbox`）の枠に掛からない規制。
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import shapely
from shapely.geometry import LineString, MultiPolygon, Polygon, box
from shapely.geometry.base import BaseGeometry

from app.batch.ingest import SourceRecord, register_adapter
from app.batch.source_adapters.abr import RangeInputs, range_inputs
from app.batch.source_adapters.zip_csv import read_zip_csv
from app.batch.source_profile import SourceProfile, SourceSpec
from app.infrastructure import data_paths

DATA_DIR = data_paths.DATA_DIR / "jartic"

ENCODING = "cp932"
#: 規制の鍵（全国で一意）。
_KEY_COLUMN = "ユニークキー"
#: 点・線・面コードの線と面。
_LINE = "2"
_AREA = "3"


@dataclass(frozen=True)
class JarticRegulationRows:
    """`jartic_regulation`の`rows`。"""

    #: 配布の版（配布元の置き場の名前。例: `202611010000`）。全都道府県で共通。
    version: str
    #: 取り込む共通規制種別コード（例: 歩行者用道路は`1`）。
    kinds: list[str]


def archive_path(version: str, prefecture: str) -> Path:
    """取り出した都道府県（JIS の2桁）の配布の置き場。取得（`scripts/fetch_jartic_regulations.py`）と取込で同じ導き方を使う。"""
    return DATA_DIR / version / f"{prefecture}.zip"


def jartic_regulation_inputs(spec: SourceSpec, profile: SourceProfile) -> RangeInputs:
    return range_inputs(profile, lambda code: archive_path(spec.rows.version, code))


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


@register_adapter("jartic_regulation", rows=JarticRegulationRows, inputs=jartic_regulation_inputs)
async def read_jartic_regulations(spec: SourceSpec, profile: SourceProfile, inputs: RangeInputs,
                                  origin: dict[str, Any]) -> AsyncIterator[SourceRecord]:
    rows: JarticRegulationRows = spec.rows
    origin["version"] = rows.version
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
