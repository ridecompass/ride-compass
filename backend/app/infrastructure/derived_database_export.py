"""OSM の派生データベース（道ごとの値）を、ODbL の表示を付けた1つの ZIP に書き出し、ディスクへ置く。

地図のタイル・道の鍵を付けた値の配信・ルートは OSM の派生データベースを公に使うので、その全体を受け取った人が取れるように
する（docs/architecture/data-sources.md「OSM から作った値と独自の層」）。書くのは派生の作り直しの入口（`batch/derive_cli.py: main`）の
終わりだけで、backend は置かれた最新の1つを配るだけにする。取込・派生の作り直しと同時に書かないための鍵は、その入口が持つ。

置き場は`data/derived_database/`で、中に置くのは最新の1つだけ。名前は形の署名と派生・生データの世代を持ち、今の世代・形の
ものが既にあれば書かない。書き終えるまでは読み手が拾わない名前（先頭が`.`）に書き、最後に名前を付け替えてから古いものを消す。
"""

import asyncio
import csv
import html
import inspect
import io
import logging
import re
import shutil
import time
import zipfile
from collections.abc import Callable, Iterator
from pathlib import Path

import numpy as np
import shapely
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.attributes import CategoricalColumn
from app.domain.feature_materials import FeatureMaterials
from app.domain.map_display import DERIVED_DATABASE_ATTRIBUTIONS
from app.domain.material_catalog import MATERIAL_CATALOG, material_array_columns
from app.domain.region import EDGE_UNIT_MIN_ZOOM
from app.domain.road_features import MapFeatures, feature_lines, feature_materials, feature_rows, map_features
from app.domain.road_network import RoadNetwork
from app.infrastructure import road_network_store
from app.infrastructure.cache_identity import shape_digest
from app.infrastructure.data_paths import DATA_DIR
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.infrastructure.road_tile_sql import WAY_NAMES_SQL

logger = logging.getLogger("ridecompass.derived_database")

#: 本番の読み手はこのファイルだけだが、テストがディスク（プロセス境界）の置き場を一時ディレクトリへ差し替えるために公開する
#: （testing.md「確かめる高さ」の (c)）。
ROOT = DATA_DIR / "derived_database"

#: 書き出す材料（道路網の配列が持つ全材料。値は道路網の配列のフィーチャーの値で、地図とルートが読むのと同じ）。行は区間で塗る
#: ズームの地図のフィーチャー（`domain/road_features.py: map_features`）で、地図と同じ単位・形にする。
DERIVED_DATABASE_MATERIAL_IDS = tuple(sorted(material_id for ids in material_array_columns() for material_id in ids))
COLUMNS = ("osm_way_id", "segment_index", "length_m", "name", "ref", *DERIVED_DATABASE_MATERIAL_IDS, "geometry_wkt")
DATA_FILE = "roads.csv"
README_FILE = "README.txt"


def _material_line(material_id: str) -> str:
    spec = MATERIAL_CATALOG[material_id]
    unit = f"（{spec.unit}）" if spec.unit else ""
    return f"- {material_id}: {spec.label}{unit}。{' '.join(spec.description.split())}"


_LINK = re.compile(r'<a href="([^"]*)"[^>]*>(.*?)</a>')


def _plain_attribution(attribution_html: str) -> str:
    """地図の出典表記（HTML）を、リンク先を文字の後ろに並べた文にする。"""
    return "- " + html.unescape(_LINK.sub(r"\2 (\1)", attribution_html))


#: ODbL 4.3 の表示と、OSM 以外の元データの出典・加工した旨・加工した主体（PDL1.0 1.1.2・CC BY 4.0 3(a)）と、列の説明。
README = f"""RideCompass derived database / RideCompass 派生データベース

This database contains information from OpenStreetMap (https://www.openstreetmap.org/copyright),
which is made available here under the Open Database License (ODbL) 1.0:
https://opendatacommons.org/licenses/odbl/1-0/
© OpenStreetMap contributors

The database as a whole is made available under the ODbL 1.0. It also contains values made from the
following sources, which were processed by RideCompass:
{chr(10).join(_plain_attribution(attribution) for attribution in DERIVED_DATABASE_ATTRIBUTIONS)}
These processed values are not made by, and are not endorsed by, the original providers.
加工した値は、元データの提供元が作成したものではありません。

{DATA_FILE}: one row per road segment.
Coordinates are EPSG:4326 (WKT). Columns:
- osm_way_id, segment_index: the OSM way and the segment along it
- length_m: length in metres
- name, ref: OSM name / ref
- geometry_wkt: shape of the segment
- the other columns: per-road values (materials). An empty cell means no value.
{chr(10).join(_material_line(material_id) for material_id in DERIVED_DATABASE_MATERIAL_IDS)}
Weather values (wind, rain) and human-set calibration values are not included.
"""

_FILE_PATTERN = re.compile(r"^ridecompass-derived-database-(?P<shape>[0-9a-f]+)-r(?P<derived>\d+|x)-i(?P<imported>\d+)\.zip$")
_STREAM_CHUNK = 20_000
#: 書く間もこれより空きが減ったら止める。置き場はホストのディレクトリ（キャッシュ・道路網の置き場と同じディスク）で、
#: 書き出しで埋めると backend のキャッシュと道路網の作り直しが書けなくなる。
MIN_FREE_BYTES = 2 * 1024**3
_PROGRESS_INTERVAL_SECONDS = 30.0


def latest() -> Path | None:
    """置いてある書き出し（書き終えたもの）。置くのは1つだけなので、名前の形に合う最初のもの。無ければNone。"""
    for path in sorted(ROOT.glob("*.zip")):
        if _FILE_PATTERN.match(path.name) and path.is_file():
            return path
    return None


async def ensure_current(session: AsyncSession) -> Path:
    """今の世代・今の形の書き出しを置く。既にあれば書かない。"""
    repository = RoadGraphRepository(session)
    revisions = await repository.get_data_revisions()
    derived = "x" if revisions.derived is None else revisions.derived
    target = ROOT / f"ridecompass-derived-database-{EXPORT_SHAPE}-r{derived}-i{revisions.imported}.zip"
    if target.exists():
        logger.info("派生データベースは書き出し済みです %s", target.name)
        return target
    await _write(repository, target)
    _prune(keep=target)
    return target


async def _write(repository: RoadGraphRepository, target: Path) -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for leftover in ROOT.glob(".*"):
        leftover.unlink()
    _require_free_space()
    pending = ROOT / f".{target.name}"
    started = time.perf_counter()
    try:
        rows = await _write_zip(repository, pending, _require_free_space)
    except BaseException:
        pending.unlink(missing_ok=True)
        raise
    pending.rename(target)
    logger.info("派生データベースを書き出しました %s 行=%d 大きさ=%.1fMB 所要=%.1f秒",
                target.name, rows, target.stat().st_size / 1e6, time.perf_counter() - started)


async def _write_zip(repository: RoadGraphRepository, path: Path, check_space: Callable[[], None]) -> int:
    # 道路網を読むのは、イベントループの外で行う。
    network = await asyncio.to_thread(road_network_store.current)
    rows = 0
    started = last_progress = time.perf_counter()
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(README_FILE, README)
        with archive.open(DATA_FILE, "w", force_zip64=True) as raw, \
                io.TextIOWrapper(raw, encoding="utf-8", newline="") as data:
            writer = csv.writer(data)
            writer.writerow(COLUMNS)
            first = network.edge_first_rows
            for begin in range(0, len(first), _STREAM_CHUNK):
                features, lines = await asyncio.to_thread(_chunk, network, first[begin:begin + _STREAM_CHUNK])
                names = await repository.get_way_names(sorted(set(features.way_ids)))
                writer.writerows(lines(names))
                rows += len(features)
                check_space()
                now = time.perf_counter()
                if now - last_progress >= _PROGRESS_INTERVAL_SECONDS:
                    last_progress = now
                    logger.info("派生データベースを書き出し中 行=%d 経過=%.0f秒", rows, now - started)
    return rows


def _chunk(network: RoadNetwork, rows: np.ndarray
           ) -> tuple[MapFeatures, Callable[[dict[int, tuple[str | None, str | None]]], Iterator[tuple[object, ...]]]]:
    """区間の一番若い行`rows`の区間のフィーチャーと、道の番号→名前から書き出しの行を並べる関数。道路網を読むので、イベント
    ループの外で呼ぶ。"""
    features = map_features(network, EDGE_UNIT_MIN_ZOOM, rows)
    edge_rows, way_rows = feature_rows(network, features.way_ids, features.segment_indexes)
    materials = feature_materials(network, features.keys, edge_rows, way_rows)
    # 座標の桁はOSMが持つ桁（小数7桁）で、丸めで形を変えない。
    shapes = shapely.to_wkt(feature_lines(network, features), rounding_precision=7, trim=True).tolist()
    lengths = np.asarray(network.distance_m)[features.shape_rows].tolist()

    def lines(names: dict[int, tuple[str | None, str | None]]) -> Iterator[tuple[object, ...]]:
        for i, (way_id, segment) in enumerate(zip(features.way_ids, features.segment_indexes, strict=True)):
            yield (way_id, segment, lengths[i], *names.get(way_id, (None, None)),
                   *(_cell(materials, material_id, i) for material_id in DERIVED_DATABASE_MATERIAL_IDS), shapes[i])

    return features, lines


#: 置き場の名前の形の署名。列・値式・表示・行の選び方を変えたコードは、同じ世代でも別の名前に書く。
EXPORT_SHAPE = shape_digest(WAY_NAMES_SQL, road_network_store.NETWORK_SHAPE, COLUMNS, README, inspect.getsource(_chunk))


def _cell(materials: FeatureMaterials, material_id: str, row: int) -> str | float | bool | None:
    """材料の値の欄（値の無い材料は空）。真偽は真偽で書く（配列は1.0/0.0で持つ）。"""
    column = materials.columns[material_id]
    if isinstance(column, CategoricalColumn):
        return column.value_at(row)
    value = float(column[row])
    if value != value:  # NaN
        return None
    return bool(value) if MATERIAL_CATALOG[material_id].dtype == "boolean" else value


def _require_free_space() -> None:
    free = shutil.disk_usage(ROOT).free
    if free < MIN_FREE_BYTES:
        raise OSError(f"置き場のディスクの空きが足りないので、派生データベースを書き出しません free={free}")


def _prune(keep: Path) -> None:
    """書き終えたもののうち、`keep`でないものを消す。"""
    for path in ROOT.glob("*.zip"):
        if path != keep and _FILE_PATTERN.match(path.name):
            path.unlink()
