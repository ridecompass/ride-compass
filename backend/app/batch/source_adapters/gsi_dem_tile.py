"""地理院の標高タイルのアダプタ。

**製品×タイル1枚を1行**として返す。これで面のデータが点・線と同じ骨格に乗り、取込の経路を
分けずに済む。同じタイル座標に複数の製品があれば、その数だけ行ができる——どの製品の値を
採るかは画素ごとの判断で、派生（`derive_elevation.py`）が持つ。

取得（`fetch_dem_tiles`）は、取込のトランザクションの外で配信元から`app/batch/dem_tile_store.py`が指す置き場へタイルを写し、
取込はそこにあるものを読む——トランザクションの中でHTTPを叩くと、関東全域（z15で約6万枚）では外部の一時的な失敗ひとつで
全部やり直しになる。取得は**プロファイルが挙げた製品を、それぞれのズームで全タイル取る**。1つの製品が返したからといって
他の製品を取りやめない。その製品に無いタイル（404）は製品ごとに区域外の印を置き、置くタイルの更新時刻は配信元の最終更新
（`Last-Modified`）にする。返さなかったタイルは置かずに止まる。

標高をint32（0.01m単位）で並べ、`raster`として持つ。配信元のPNGは画素の色に標高を
符号化しており、DBの中で画素を読むには値の並びへ戻しておく必要がある。位置・画素の大きさ・
型・欠測値は`raster`の値自身が持つので、読み手は`attrs`から形を組み立てない。

どの製品をどのズームで読むかはプロファイルが持ち、実装は持たない。
"""

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Any

import httpx
import numpy as np

from app.batch import dem_tile_store
from app.batch.common import PROGRESS_INTERVAL_SECONDS, format_progress
from app.batch.ingest import AdapterInputs, Fetcher, SourceRecord, register_adapter
from app.batch.source_adapters.raster_wkb import tile_bbox_wkb, tile_raster_wkb
from app.batch.source_profile import SourceProfile, SourceProfileError, SourceSpec
from app.domain.region import tiles_covering_bbox
from app.infrastructure.gsi_dem_png import read_gsi_dem_png
from app.infrastructure.source_models import SourceFeatureRow

logger = logging.getLogger("ridecompass.ingest.gsi_dem_tile")

#: 1枚の一辺の画素数。配信元の仕様で、自前で描くタイルの画素数
#: （`infrastructure/landcover_raster.py: TILE_SIZE`）を変えてもこちらは変わらない。
#: 出典: https://maps.gsi.go.jp/development/demtile.html
_DEM_TILE_SIZE = 256

#: 詰めるときの尺度と欠測値。地理院の標高タイル（PNG形式）の標高分解能が0.01mなので、
#: 画素の値をそのまま0.01m単位として丸めずに保つ。
#: 出典: https://maps.gsi.go.jp/development/demtile.html
#:
#: 型はint32。関東のbboxには富士山（3,776m）が入り、0.01m単位では377,600となって
#: int16（上限32,767＝3,276.7m）に収まらない。
SCALE = 100
NODATA = -2147483648


def pack_elevations(png: bytes) -> tuple[bytes, int]:
    """タイル1枚（PNG）を、画素の順（行ごと）にint32の配列へ詰める。欠測の画素の数も返す。"""
    elevations, missing = read_gsi_dem_png(png)
    packed = np.where(missing, NODATA, elevations).astype("<i4")
    return packed.tobytes(), int(missing.sum())


@dataclass(frozen=True)
class DemGrid:
    """`gsi_dem_tile`の`grid`。"""

    #: 配信元の製品名（`dem5a`等）→ 読むズーム。
    products: dict[str, int]

    def __post_init__(self) -> None:
        unknown = sorted(set(self.products) - set(dem_tile_store.PRODUCT_PRIORITY))
        if not self.products or unknown:
            raise SourceProfileError(
                f"gsi_dem_tile の grid.products は {dem_tile_store.PRODUCT_PRIORITY} から"
                f"選んでください（知らない製品: {unknown}）")


@dataclass(frozen=True)
class ProductTiles:
    """1製品の、範囲を覆うタイルの内訳。"""

    product: str
    zoom: int
    #: 範囲を覆うタイルの数。
    covering: int
    #: 置き場にあるタイルの (x, y)。区域外の印とまだ写していないタイルは、どちらも行にならない。
    stored: tuple[tuple[int, int], ...]
    #: 区域外の印のあるタイルの数。
    absent: int

    @property
    def unfetched(self) -> int:
        return self.covering - len(self.stored) - self.absent


@dataclass(frozen=True, kw_only=True)
class DemInputs(AdapterInputs):
    products: tuple[ProductTiles, ...]

    def origin(self) -> dict[str, Any]:
        # タイルは数千枚になるので、ファイルの一覧ではなく置き場と製品を書く。
        return {"tile_root": str(dem_tile_store.TILE_ROOT),
                "products": {tiles.product: tiles.zoom for tiles in self.products}}


def _product_tiles(product: str, zoom: int, profile: SourceProfile) -> ProductTiles:
    root = dem_tile_store.TILE_ROOT
    covering = tiles_covering_bbox(profile.target.bounding_box(), zoom)
    stored: list[tuple[int, int]] = []
    absent = 0
    for x, y in covering:
        if dem_tile_store.is_stored(root, product, zoom, x, y):
            stored.append((x, y))
        elif dem_tile_store.is_absent(root, product, zoom, x, y):
            absent += 1
    return ProductTiles(product=product, zoom=zoom, covering=len(covering), stored=tuple(stored), absent=absent)


def gsi_dem_adapter_inputs(spec: SourceSpec, profile: SourceProfile) -> DemInputs:
    root = dem_tile_store.TILE_ROOT
    products = tuple(_product_tiles(str(product), int(zoom), profile) for product, zoom in spec.grid.products.items())
    return DemInputs(files=tuple(dem_tile_store.tile_path(root, tiles.product, tiles.zoom, x, y)
                                 for tiles in products for x, y in tiles.stored),
                     products=products)


#: 配信元へ並べてよい数の上限。公共サービスなので控えめにする。
_MAX_CONCURRENT = 8

#: 進捗を数えて出す区切りの枚数。
_CHUNK = _MAX_CONCURRENT * 8

_REQUEST_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=10.0)


async def _fetch_tile(client: httpx.AsyncClient, product: str, zoom: int,
                      x: int, y: int) -> tuple[bytes, datetime] | None:
    """本文と配信元での最終更新。その製品に無ければ（404）None。"""
    response = await client.get(
        dem_tile_store.TILE_URL.format(product=product, z=zoom, x=x, y=y), timeout=_REQUEST_TIMEOUT)
    if response.status_code == 404:
        return None
    response.raise_for_status()
    header = response.headers.get("Last-Modified")
    if header is None:
        # 置くと、取込がいつ時点の標高かを記録できない。
        raise RuntimeError("Last-Modified がありません")
    return response.content, parsedate_to_datetime(header)


async def _fetch_product(client: httpx.AsyncClient, product: str, zoom: int,
                         tiles: list[tuple[int, int]]) -> dict[str, int]:
    """1製品ぶんのタイルを取りに行く。結果の内訳を返す。"""
    root = dem_tile_store.TILE_ROOT
    counts = {"取得": 0, "区域外": 0}
    semaphore = asyncio.Semaphore(_MAX_CONCURRENT)
    started = time.perf_counter()

    async def one(x: int, y: int) -> None:
        async with semaphore:
            fetched = await _fetch_tile(client, product, zoom, x, y)
        if fetched is None:
            dem_tile_store.mark_absent(root, product, zoom, x, y)
            counts["区域外"] += 1
        else:
            dem_tile_store.write_tile(root, product, zoom, x, y, *fetched)
            counts["取得"] += 1

    last_report = started
    for start in range(0, len(tiles), _CHUNK):
        await asyncio.gather(*(one(x, y) for x, y in tiles[start:start + _CHUNK]))
        now = time.perf_counter()
        done = counts["取得"] + counts["区域外"]
        if now - last_report < PROGRESS_INTERVAL_SECONDS and done < len(tiles):
            continue
        last_report = now
        logger.info("進捗 %s %s", product, format_progress(done, len(tiles), now - started, "枚"))
    return counts


async def _fetch_products(spec: SourceSpec, profile: SourceProfile) -> None:
    bbox = profile.target.bounding_box()
    async with httpx.AsyncClient() as client:
        for product, zoom in spec.grid.products.items():
            tiles = tiles_covering_bbox(bbox, int(zoom))
            logger.info("標高タイル: product=%s zoom=%d 対象%d枚 / 置き場 %s",
                        product, zoom, len(tiles), dem_tile_store.TILE_ROOT)
            started = time.perf_counter()
            counts = await _fetch_product(client, str(product), int(zoom), tiles)
            logger.info("完了 product=%s zoom=%d: %s / %.1f秒", product, zoom,
                        " / ".join(f"{k} {v:,}" for k, v in counts.items()), time.perf_counter() - started)


def fetch_dem_tiles(spec: SourceSpec, profile: SourceProfile) -> None:
    asyncio.run(_fetch_products(spec, profile))


@register_adapter("gsi_dem_tile", grid=DemGrid, required=(SourceFeatureRow.rast,), inputs=gsi_dem_adapter_inputs,
                  fetcher=Fetcher(fetch_dem_tiles, lambda: (dem_tile_store.TILE_ROOT,)))
async def read_gsi_dem_tiles(spec: SourceSpec, profile: SourceProfile, inputs: DemInputs,
                             origin: dict[str, Any]) -> AsyncIterator[SourceRecord]:
    root = dem_tile_store.TILE_ROOT
    newest = None

    for tiles in inputs.products:
        product, zoom = tiles.product, tiles.zoom
        for x, y in tiles.stored:
            modified = dem_tile_store.tile_modified(root, product, zoom, x, y)
            newest = modified if newest is None else max(newest, modified)
            pixels, missing = pack_elevations(dem_tile_store.read_tile(root, product, zoom, x, y))
            yield SourceRecord(
                natural_key=f"{product}/{zoom}/{x}/{y}",
                geom_wkb=tile_bbox_wkb(zoom, x, y),
                # 型・欠測値・位置はrasterの値自身が持つため書かない。尺度（0.01m単位）は
                # rasterが持てず、幅は画素の番地を出すのに要る——rasterから読むと、その
                # たびにタイルの画素が実体化される。
                attrs={
                    "product": product, "z": zoom, "x": x, "y": y,
                    "width": _DEM_TILE_SIZE, "scale": SCALE, "missing": missing,
                },
                rast=tile_raster_wkb(
                    pixels, zoom=zoom, x=x, y=y,
                    width=_DEM_TILE_SIZE, height=_DEM_TILE_SIZE,
                    dtype="int32_le", nodata=NODATA),
            )
        logger.info("標高タイル: product=%s zoom=%d 対象%d枚 / 読んだ%d枚・区域外%d枚 / 置き場 %s",
                    product, zoom, tiles.covering, len(tiles.stored), tiles.absent, root)
        if tiles.unfetched:
            logger.warning("まだ写していない標高タイル: product=%s zoom=%d %d枚"
                           "（python -m app.batch.fetch_cli --source dem が写す）", product, zoom, tiles.unfetched)
    origin["tiles_last_modified"] = None if newest is None else newest.isoformat()
