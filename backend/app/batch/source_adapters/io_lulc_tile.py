"""土地被覆ラスタ（Esri×Impact Observatory LULC）のアダプタ。

配信元はUTMゾーン単位の大きなGeoTIFFだが、**取り込むときにタイルへ切る**。標高と同じ
格子に載せることで、面のソースが1つの形にそろい、読み手が形ごとの扱いを持たなくて済む。

ズームは元データの分解能から決める（10m画素なのでz14が7.73m/画素で釣り合う）。

取得（`fetch_lulc_rasters`）は、取込の範囲（`target.bbox`）に掛かるUTMゾーンごとに、配布元が出している最新の年のラスタを
置き場（`data_paths.py: RASTER_DIR`）へ取る。ゾーンと年は配布元のSTAC APIの品目の検索で引く（品目1つがゾーン×年の
GeoTIFF1枚）。取込と地図のラスタタイルは、置き場にあるラスタを全部読む。
"""

import logging
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from app.batch.common import FetchError, fetch_once, fetch_timeout
from app.batch.ingest import AdapterInputs, Fetcher, SourceRecord, register_adapter
from app.batch.source_adapters.raster_wkb import tile_bbox_wkb, tile_raster_wkb
from app.batch.source_profile import SourceProfile, SourceSpec
from app.domain.region import tiles_covering_bbox
from app.infrastructure import data_paths
from app.infrastructure.source_models import SourceFeatureRow

logger = logging.getLogger("ridecompass.ingest.io_lulc_tile")

#: 配布元のSTAC API（STAC 1.0.0のItem Search）。AWS Open Data Registryの`io-lulc`が名指す入口で、品目の資産`supercell`が
#: GeoTIFFの所在（AWS S3の公開バケット。サインなしで読める）を持つ。
STAC_SEARCH_URL = "https://api.impactobservatory.com/stac-aws/search"
COLLECTION = "io-10m-annual-lulc"
_ASSET = "supercell"
#: 1ページの品目の数。ゾーン1つに年ごとの品目が並ぶので、範囲が数ゾーンなら1ページに収まる。
_PAGE_LIMIT = 100

_READ_TIMEOUT_SECONDS = 600.0
_SEARCH_READ_TIMEOUT_SECONDS = 60.0


@dataclass(frozen=True)
class LulcGrid:
    """`io_lulc_tile`の`grid`。"""

    zoom: int


def lulc_adapter_inputs(spec: SourceSpec, profile: SourceProfile) -> AdapterInputs:
    """置き場のGeoTIFF。"""
    # rasterioのimport順の制約（PROJデータの固定）を持つモジュールを経由して読む。
    from app.infrastructure.landcover_raster import opened_raster_paths

    return AdapterInputs(files=tuple(Path(raster) for raster in opened_raster_paths()))


def _latest_rasters(items: Iterable[dict[str, Any]]) -> list[str]:
    """STACの品目から、ゾーンごとに最新の年のGeoTIFFの所在を返す。

    ゾーンはGeoTIFFのファイル名（`<ゾーン>_<年>.tif`。例: `54S_2024.tif`）から、年は品目の`datetime`から読む。
    """
    latest: dict[str, tuple[datetime, str]] = {}
    for item in items:
        href = item["assets"][_ASSET]["href"]
        zone = href.rsplit("/", 1)[-1].rsplit("_", 1)[0]
        taken = datetime.fromisoformat(item["properties"]["datetime"])
        if zone not in latest or latest[zone][0] < taken:
            latest[zone] = (taken, href)
    return [href for _, href in sorted(latest.values(), key=lambda pair: pair[1])]


def _search(profile: SourceProfile) -> list[dict[str, Any]]:
    """範囲に掛かる品目を、次のページ（リンク`next`）を辿って全部読む。"""
    min_lat, min_lon, max_lat, max_lon = profile.target.bbox
    url: str | None = STAC_SEARCH_URL
    params: dict[str, Any] | None = {
        "collections": COLLECTION, "bbox": f"{min_lon},{min_lat},{max_lon},{max_lat}", "limit": _PAGE_LIMIT}
    items: list[dict[str, Any]] = []
    while url is not None:
        response = httpx.get(url, params=params, timeout=fetch_timeout(_SEARCH_READ_TIMEOUT_SECONDS),
                             follow_redirects=True)
        response.raise_for_status()
        page = response.json()
        items.extend(page["features"])
        url = next((link["href"] for link in page.get("links", []) if link["rel"] == "next"), None)
        params = None  # 次のページのリンクは条件を含む
    return items


def fetch_lulc_rasters(spec: SourceSpec, profile: SourceProfile) -> None:
    """範囲に掛かるゾーンごとに、最新の年のラスタを置き場へ取る。"""
    hrefs = _latest_rasters(_search(profile))
    if not hrefs:
        raise FetchError("範囲に掛かる土地被覆のラスタが配布元にありません")
    for href in hrefs:
        fetch_once(href, data_paths.RASTER_DIR / href.rsplit("/", 1)[-1],
                   read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)


@register_adapter("io_lulc_tile", grid=LulcGrid, required=(SourceFeatureRow.rast,), inputs=lulc_adapter_inputs,
                  fetcher=Fetcher(fetch_lulc_rasters, lambda: (data_paths.RASTER_DIR,)))
async def read_lulc_tiles(spec: SourceSpec, profile: SourceProfile, inputs: AdapterInputs,
                          origin: dict[str, Any]) -> AsyncIterator[SourceRecord]:
    from app.infrastructure.landcover_raster import tile_classes

    zoom = int(spec.grid.zoom)
    origin["zoom"] = zoom
    tiles = tiles_covering_bbox(profile.target.bounding_box(), zoom)
    logger.info("土地被覆タイル: zoom=%d 対象%d枚", zoom, len(tiles))

    uncovered = 0
    for x, y in tiles:
        classes = tile_classes(zoom, x, y)
        if classes is None:
            uncovered += 1
            continue
        # 画素数は描画が切った配列から読む——タイルの一辺を決めるのは描画の側で、ここではない。
        height, width = classes.shape
        yield SourceRecord(
            natural_key=f"{zoom}/{x}/{y}",
            geom_wkb=tile_bbox_wkb(zoom, x, y),
            # 型・欠測値・位置はrasterの値自身が持つため書かない。幅は画素の番地を
            # 出すのに要る（rasterから読むと画素が実体化される）。
            attrs={"z": zoom, "x": x, "y": y, "width": width},
            rast=tile_raster_wkb(
                classes.tobytes(), zoom=zoom, x=x, y=y,
                width=width, height=height, dtype="uint8", nodata=0),
        )
    if uncovered:
        logger.info("ラスタが覆っていないタイル: %d枚", uncovered)
