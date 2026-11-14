"""Mapillary のベクタータイルのアダプタ。道の写真から見つけた物の点（`mly_map_feature_point`）と、写真を撮った線
（`mly1_public`の`sequence`）を、タイルの層1つにつき1つのアダプタで扱う。

取得は、取込の範囲を覆う宣言のズーム（`grid.zoom`）のタイルを全部タイルの口から取り、層の地物を
緯度経度へ直してタイルごとに置き場の`tiles/`へ置く。全部そろったら1つのファイル（`FEATURES_NAME`）へまとめて置き換え、
`tiles/`を消す。断られても通信が落ちても、置いたタイルを残して止まり、次に打つとまだ置いていないタイルから続ける——タイルの口は
読み出しに1日の上限があり、短い間に多く読むとログインへの転送や403を返して、しばらく断り続ける。まとめたあとの取得は全部を取り直す。

取込は、まとめたファイルの地物を1件ずつ、配られた属性のまま返す。落とすのは、点の物の種類が宣言（`rows.values`）に無い地物と、
形が取込の範囲（`target.bbox`）の枠に掛からない地物。撮影の線はタイルの境で切れて配られるので、1本の線のタイルごとの切れ端を1行にする。
"""

import asyncio
import gzip
import json
import logging
import shutil
import time
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import mapbox_vector_tile
import numpy as np
import shapely
from shapely.geometry import box, shape

from app.batch.common import (
    FETCH_PART_SUFFIX,
    PROGRESS_INTERVAL_SECONDS,
    FetchError,
    format_progress,
    place_file,
    read_fetch_record,
    write_fetch_record,
)
from app.batch.ingest import AdapterInputs, Fetcher, SourceRecord, register_adapter
from app.batch.source_profile import SourceProfile, SourceSpec
from app.config import settings
from app.domain.region import tile_lonlat, tiles_covering_bbox
from app.infrastructure import data_paths

DATA_DIR = data_paths.DATA_DIR / "mapillary"

logger = logging.getLogger("ridecompass.ingest.mapillary_tile")

#: タイルの口（https://www.mapillary.com/developer/api-documentation の Vector tiles）。鍵は問い合わせの`access_token`で渡す
#: （ヘッダーで渡すと403を返す）。
TILE_URL = "https://tiles.mapillary.com/maps/vtp/{tileset}/2/{z}/{x}/{y}"

#: まとめた地物のファイル（1行1地物のJSONをgzipで縮めたもの）の名前。
FEATURES_NAME = "features.jsonl.gz"

#: 並べて読む数と、1つの読み手が次を読むまでの間（秒）。決め方は docs/architecture/data-sources.md「Mapillary のタイル」。
_MAX_CONCURRENT = 2
_INTERVAL_SECONDS = 0.5

_REQUEST_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=30.0)


@dataclass(frozen=True)
class MapillaryGrid:
    """Mapillary のアダプタの`grid`。"""

    #: 読むタイルのズーム。
    zoom: int


@dataclass(frozen=True)
class MapillaryPointRows:
    """`mapillary_map_feature_point`の`rows`。"""

    #: 取り込む物の種類（配られた`value`。例: 街灯は`object--street-light`）。
    values: list[str]


@dataclass(frozen=True)
class _Layer:
    """タイルの層1つと、その地物の鍵の作り方。"""

    adapter: str
    tileset: str
    layer: str
    #: 地物の属性とタイルの (z, x, y) から、ソースの中で一意な鍵を作る。
    key: Callable[[dict[str, Any], int, int, int], str]

    def store(self) -> Path:
        return DATA_DIR / self.adapter


POINT = _Layer("mapillary_map_feature_point", "mly_map_feature_point", "point",
               lambda attrs, z, x, y: str(attrs["id"]))
SEQUENCE = _Layer("mapillary_sequence", "mly1_public", "sequence",
                  lambda attrs, z, x, y: f"{attrs['id']}/{z}/{x}/{y}")


def _tile_path(store: Path, z: int, x: int, y: int) -> Path:
    return store / "tiles" / str(z) / str(x) / f"{y}.json"


def _lonlat_transform(z: int, x: int, y: int, extent: int) -> Callable[[np.ndarray], np.ndarray]:
    """タイルの中の座標（左上が原点で下へ増える）を経度・緯度へ移す関数。"""
    def transform(coordinates: np.ndarray) -> np.ndarray:
        return np.array([tile_lonlat(x + px / extent, y + py / extent, z) for px, py in coordinates])

    return transform


def tile_features(layer: _Layer, content: bytes, z: int, x: int, y: int) -> list[dict[str, Any]]:
    """タイル1枚の層の地物を、鍵・形（WKBの16進）・配られた属性にする。層の無いタイルは地物が無い。"""
    decoded = mapbox_vector_tile.decode(content, default_options={"y_coord_down": True}).get(layer.layer)
    if decoded is None:
        return []
    transform = _lonlat_transform(z, x, y, decoded["extent"])
    return [{"key": layer.key(feature["properties"], z, x, y),
             "wkb": shapely.to_wkb(shapely.transform(shape(feature["geometry"]), transform), hex=True),
             "attrs": feature["properties"]}
            for feature in decoded["features"]]


def _write_json(path: Path, value: Any) -> None:
    """途中で落ちても半端なタイルを置かないよう、一時ファイルに書いてから移す。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + FETCH_PART_SUFFIX)
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


async def _fetch_tiles(layer: _Layer, token: str, z: int, tiles: list[tuple[int, int]], placed: int) -> None:
    """`tiles`を読んで置く。`placed`は前の回までに置いてあった枚数で、ログにだけ使う。"""
    store = layer.store()
    pending = iter(tiles)
    done = 0
    started = last_report = time.perf_counter()

    async def worker(client: httpx.AsyncClient) -> None:
        nonlocal done, last_report
        for x, y in pending:
            response = await client.get(TILE_URL.format(tileset=layer.tileset, z=z, x=x, y=y),
                                        params={"access_token": token}, timeout=_REQUEST_TIMEOUT)
            if response.status_code != httpx.codes.OK:
                # URLは鍵を含むので、例外にもログにも書かない。
                raise FetchError(
                    f"タイルの口が断った status={response.status_code} tileset={layer.tileset} "
                    f"置いたタイル {placed + done:,}/{placed + len(tiles):,}枚（次に打つと、まだ置いていないタイルから続ける）")
            _write_json(_tile_path(store, z, x, y), tile_features(layer, response.content, z, x, y))
            done += 1
            now = time.perf_counter()
            if now - last_report >= PROGRESS_INTERVAL_SECONDS:
                last_report = now
                logger.info("進捗 %s %s", layer.tileset, format_progress(done, len(tiles), now - started, "枚"))
            await asyncio.sleep(_INTERVAL_SECONDS)

    async with httpx.AsyncClient() as client:
        workers = [asyncio.create_task(worker(client)) for _ in range(_MAX_CONCURRENT)]
        finished, running = await asyncio.wait(workers, return_when=asyncio.FIRST_EXCEPTION)
        # 1つが断られたら、ほかの読み手も止めて、その失敗をそのまま出す（取得の入口は失敗の型を見て終了コードにする）。
        for task in running:
            task.cancel()
        await asyncio.gather(*running, return_exceptions=True)
        for task in finished:
            task.result()


def _write_features(destination: Path, store: Path, z: int, tiles: list[tuple[int, int]]) -> None:
    """置いたタイルの地物を1つのファイルへまとめる。同じ鍵の地物がタイルをまたいで2度配られたら、先の1つだけを書く。"""
    seen: set[str] = set()
    with gzip.open(destination, "wt", encoding="utf-8") as sink:
        for x, y in tiles:
            for feature in json.loads(_tile_path(store, z, x, y).read_text(encoding="utf-8")):
                if feature["key"] in seen:
                    continue
                seen.add(feature["key"])
                sink.write(json.dumps(feature, ensure_ascii=False) + "\n")
    logger.info("地物 %s件", f"{len(seen):,}")


def _fetcher(layer: _Layer) -> Fetcher:
    def fetch(spec: SourceSpec, profile: SourceProfile) -> None:
        token = settings.mapillary_token
        if not token:
            raise FetchError("MAPILLARY_TOKEN がありません")
        z = spec.grid.zoom
        store = layer.store()
        tiles = tiles_covering_bbox(profile.target.bounding_box(), z)
        remaining = [(x, y) for x, y in tiles if not _tile_path(store, z, x, y).exists()]
        logger.info("Mapillary のタイル: tileset=%s zoom=%d 対象%d枚 / 置いてある%d枚 / 置き場 %s",
                    layer.tileset, z, len(tiles), len(tiles) - len(remaining), store)
        asyncio.run(_fetch_tiles(layer, token, z, remaining, len(tiles) - len(remaining)))
        place_file(store / FEATURES_NAME, lambda temporary: _write_features(temporary, store, z, tiles),
                   source=f"置いた{layer.tileset}のタイル", logger=logger)
        shutil.rmtree(store / "tiles")
        write_fetch_record(store, tileset=layer.tileset, zoom=z, tiles=len(tiles))

    return Fetcher(fetch, lambda: (layer.store(),))


def _inputs(layer: _Layer) -> Callable[[SourceSpec, SourceProfile], AdapterInputs]:
    def inputs(spec: SourceSpec, profile: SourceProfile) -> AdapterInputs:
        return AdapterInputs(files=(layer.store() / FEATURES_NAME,))

    return inputs


def _features(layer: _Layer, profile: SourceProfile, origin: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """まとめたファイルの地物のうち、形が取込の範囲の枠に掛かるもの。取ったものの記録を`origin`へ写す。"""
    store = layer.store()
    origin.update(read_fetch_record(store))
    min_lat, min_lon, max_lat, max_lon = profile.target.bbox
    frame = box(min_lon, min_lat, max_lon, max_lat)
    with gzip.open(store / FEATURES_NAME, "rt", encoding="utf-8") as source:
        for line in source:
            feature = json.loads(line)
            feature["geometry"] = shapely.from_wkb(feature["wkb"])
            if feature["geometry"].intersects(frame):
                yield feature


def _record(feature: dict[str, Any]) -> SourceRecord:
    return SourceRecord(natural_key=feature["key"], geom_wkb=shapely.to_wkb(feature["geometry"]), attrs=feature["attrs"])


@register_adapter(POINT.adapter, rows=MapillaryPointRows, grid=MapillaryGrid, inputs=_inputs(POINT),
                  fetcher=_fetcher(POINT))
async def read_mapillary_points(spec: SourceSpec, profile: SourceProfile, inputs: AdapterInputs,
                                origin: dict[str, Any]) -> AsyncIterator[SourceRecord]:
    rows: MapillaryPointRows = spec.rows
    values = set(rows.values)
    for feature in _features(POINT, profile, origin):
        if feature["attrs"]["value"] in values:
            yield _record(feature)


@register_adapter(SEQUENCE.adapter, grid=MapillaryGrid, inputs=_inputs(SEQUENCE), fetcher=_fetcher(SEQUENCE))
async def read_mapillary_sequences(spec: SourceSpec, profile: SourceProfile, inputs: AdapterInputs,
                                   origin: dict[str, Any]) -> AsyncIterator[SourceRecord]:
    for feature in _features(SEQUENCE, profile, origin):
        yield _record(feature)

