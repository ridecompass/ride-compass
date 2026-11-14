"""土地被覆ラスタ（Esri×Impact Observatory LULC）のアダプタ。

配信元はUTMゾーン単位の大きなGeoTIFFだが、**取り込むときにタイルへ切る**。標高と同じ
格子に載せることで、面のソースが1つの形にそろい、読み手が形ごとの扱いを持たなくて済む。

ズームは元データの分解能から決める（10m画素なのでz14が7.73m/画素で釣り合う）。

取得（`fetch_lulc_rasters`）は、設定（`settings.lulc_raster_paths`）が指すファイルを配布元から写す。取得元はAWS S3の公開バケット
（サインなしで読める）で、設定のパスのファイル名（UTMゾーンと年。例: `54S_2024.tif`）をそのままバケットの中のキーとして使う——
どのゾーン・どの年を使うかは設定が決める。
"""

import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.batch.common import fetch_once
from app.batch.ingest import AdapterInputs, Fetcher, SourceRecord, register_adapter
from app.batch.source_adapters.raster_wkb import tile_bbox_wkb, tile_raster_wkb
from app.batch.source_profile import SourceProfile, SourceSpec
from app.config import settings
from app.domain.region import tiles_covering_bbox
from app.infrastructure.source_models import SourceFeatureRow

logger = logging.getLogger("ridecompass.ingest.io_lulc_tile")

#: 配布元。`aws s3 cp --no-sign-request`と同じ内容をHTTPSで取得する（認証もCLIも要らない）。
BUCKET_BASE_URL = "https://io-10m-annual-lulc.s3.us-west-2.amazonaws.com"

_READ_TIMEOUT_SECONDS = 600.0


@dataclass(frozen=True)
class LulcGrid:
    """`io_lulc_tile`の`grid`。"""

    zoom: int


def lulc_adapter_inputs(spec: SourceSpec, profile: SourceProfile) -> AdapterInputs:
    """設定したGeoTIFF（全部が開けなければ`LandcoverUnavailableError`）。"""
    # rasterioのimport順の制約（PROJデータの固定）を持つモジュールを経由して読む。
    from app.infrastructure.landcover_raster import opened_raster_paths

    return AdapterInputs(files=tuple(Path(raster) for raster in opened_raster_paths()))


def _raster_paths() -> tuple[Path, ...]:
    return tuple(Path(raw) for raw in settings.lulc_raster_paths_list)


def fetch_lulc_rasters(spec: SourceSpec, profile: SourceProfile) -> None:
    """設定のパスに無いラスタを取る。"""
    for path in _raster_paths():
        fetch_once(f"{BUCKET_BASE_URL}/{path.name}", path, read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)


@register_adapter("io_lulc_tile", grid=LulcGrid, required=(SourceFeatureRow.rast,), inputs=lulc_adapter_inputs,
                  fetcher=Fetcher(fetch_lulc_rasters, _raster_paths))
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
