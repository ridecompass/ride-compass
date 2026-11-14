"""標高タイルを配信元から手元へ写す（取込とは分ける）。

取込のトランザクションの中でHTTPを叩くと、関東全域（z15で約6万枚）では外部の一時的な
失敗ひとつで1〜2時間ぶんがやり直しになる。ここで先に写しておけば、取込はローカルの
ファイルを読むだけになり、失敗しても**欠けた分だけ**取り直せる。

**プロファイルが挙げた製品を、それぞれのズームで全タイル取る。**1つの製品が返したから
といって他の製品を取りやめない——どの製品の値を採るかは画素ごとに派生が決める。

**何度実行しても安全。**

- 手元にあるタイルは叩かない
- その製品に無いタイル（区域外）は製品ごとに印を置き、次からは叩かない
- 置くタイルの更新時刻は配信元の最終更新（`Last-Modified`）にする。返さなかったタイルは置かない
- 取れなかったタイルがあれば、その例外で止まる。置いた分は残るので、もう一度実行すると欠けた分だけ取りに行く

実行方法（backendディレクトリから）:
    .venv\\Scripts\\python.exe scripts\\fetch_dem_tiles.py
    .venv\\Scripts\\python.exe scripts\\fetch_dem_tiles.py --profile path/to/profile.yaml
"""

import argparse
import asyncio
import logging
import sys
import time
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.batch.dem_tile_store import (
    TILE_ROOT,
    TILE_URL,
    is_absent,
    is_stored,
    mark_absent,
    write_tile,
)
from app.batch.common import PROGRESS_INTERVAL_SECONDS, format_progress
from app.batch.fetch_cli import run_profile_fetch_cli
from app.batch.source_profile import SourceProfile, SourceSpec
from app.domain.region import tiles_covering_bbox
from app.infrastructure.source_models import Source

logger = logging.getLogger("ridecompass.fetch_dem_tiles")

#: 配信元へ並べてよい数の上限。公共サービスなので控えめにする。
_MAX_CONCURRENT = 8

#: 進捗を数えて出す区切りの枚数。
_CHUNK = _MAX_CONCURRENT * 8

_REQUEST_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=10.0)


async def _fetch_one(client: httpx.AsyncClient, product: str, zoom: int,
                     x: int, y: int) -> tuple[bytes, datetime] | None:
    """本文と配信元での最終更新。その製品に無ければ（404）None。"""
    response = await client.get(
        TILE_URL.format(product=product, z=zoom, x=x, y=y), timeout=_REQUEST_TIMEOUT)
    if response.status_code == 404:
        return None
    response.raise_for_status()
    header = response.headers.get("Last-Modified")
    if header is None:
        # 置くと、取込がいつ時点の標高かを記録できない。
        raise RuntimeError("Last-Modified がありません")
    return response.content, parsedate_to_datetime(header)


async def _fetch_product(client: httpx.AsyncClient, root: Path, product: str, zoom: int,
                         tiles: list[tuple[int, int]]) -> dict[str, int]:
    """1製品ぶん、手元に無いタイルだけ取りに行く。結果の内訳を返す。"""
    wanted = [
        (x, y) for x, y in tiles
        if not is_stored(root, product, zoom, x, y) and not is_absent(root, product, zoom, x, y)
    ]
    counts = {"既にある": len(tiles) - len(wanted), "取得": 0, "区域外": 0}
    if not wanted:
        return counts

    semaphore = asyncio.Semaphore(_MAX_CONCURRENT)
    started = time.perf_counter()

    async def one(x: int, y: int) -> None:
        async with semaphore:
            fetched = await _fetch_one(client, product, zoom, x, y)
        if fetched is None:
            mark_absent(root, product, zoom, x, y)
            counts["区域外"] += 1
        else:
            write_tile(root, product, zoom, x, y, *fetched)
            counts["取得"] += 1

    last_report = started
    for start in range(0, len(wanted), _CHUNK):
        chunk = wanted[start:start + _CHUNK]
        await asyncio.gather(*(one(x, y) for x, y in chunk))
        now = time.perf_counter()
        done = counts["取得"] + counts["区域外"]
        if now - last_report < PROGRESS_INTERVAL_SECONDS and done < len(wanted):
            continue
        last_report = now
        logger.info("進捗 %s %s", product, format_progress(done, len(wanted), now - started, "枚"))
    return counts


async def fetch(client: httpx.AsyncClient, root: Path, profile: SourceProfile) -> None:
    """プロファイルが挙げた製品ごとに、対象範囲のタイルを写す。"""
    bbox = profile.target.bounding_box()
    for product, zoom in profile.source(Source.DEM).grid.products.items():
        tiles = tiles_covering_bbox(bbox, zoom)
        logger.info("標高タイル: product=%s zoom=%d 対象%d枚 / 置き場 %s",
                    product, zoom, len(tiles), root)
        started = time.perf_counter()
        counts = await _fetch_product(client, root, product, zoom, tiles)
        logger.info("完了 product=%s zoom=%d: %s / %.1f秒", product, zoom,
                    " / ".join(f"{k} {v:,}" for k, v in counts.items()),
                    time.perf_counter() - started)


async def _run(profile: SourceProfile) -> bool:
    async with httpx.AsyncClient() as client:
        await fetch(client, TILE_ROOT, profile)
    return True


def _fetch_specs(args: argparse.Namespace, profile: SourceProfile, specs: list[SourceSpec]) -> bool:
    return asyncio.run(_run(profile))


def main() -> int:
    parser = argparse.ArgumentParser(description="標高タイルを手元へ写す")
    return run_profile_fetch_cli(parser, "gsi_dem_tile", _fetch_specs, logger=logger)


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
