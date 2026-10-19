"""OSM の派生データベース（道ごとの値）を、ODbL の表示を付けた1つの ZIP に書き出し、ディスクへ置く。

地図のタイル・道の鍵を付けた値の配信・ルートは OSM の派生データベースを公に使うので、その全体を受け取った人が取れるように
する（docs/architecture/data-sources.md「OSM から作った値と独自の層」）。書くのは毎日の定期の実行（`scripts/export_derived_database.py`）
だけで、backend は置かれた最新の1つを配るだけにする。取込・派生の作り直しと同時に書かないための鍵は、その入口が持つ。

置き場は`data/derived_database/`で、中に置くのは最新の1つだけ。名前は形の署名と派生・生データの世代を持ち、今の世代・形の
ものが既にあれば書かない。書き終えるまでは読み手が拾わない名前（先頭が`.`）に書き、最後に名前を付け替えてから古いものを消す。
"""

import csv
import io
import logging
import re
import shutil
import time
import zipfile
from collections.abc import Callable
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.material_catalog import MATERIAL_CATALOG
from app.infrastructure.cache_identity import shape_digest
from app.infrastructure.data_paths import DATA_DIR
from app.infrastructure.derived_data_meta import DataRevisions
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.infrastructure.road_tile_sql import DERIVED_DATABASE_MATERIAL_IDS, DERIVED_DATABASE_ROWS_SQL

logger = logging.getLogger("ridecompass.derived_database")

#: 本番の読み手はこのファイルだけだが、テストがディスク（プロセス境界）の置き場を一時ディレクトリへ差し替えるために公開する
#: （testing.md「確かめる高さ」の (c)）。
ROOT = DATA_DIR / "derived_database"

COLUMNS = ("osm_way_id", "segment_index", "length_m", "name", "ref", *DERIVED_DATABASE_MATERIAL_IDS, "geometry_wkt")
DATA_FILE = "roads.csv"
README_FILE = "README.txt"



def _material_line(material_id: str) -> str:
    spec = MATERIAL_CATALOG[material_id]
    unit = f"（{spec.unit}）" if spec.unit else ""
    return f"- {material_id}: {spec.label}{unit}。{' '.join(spec.description.split())}"


#: ODbL 4.3 の表示と、OSM 以外の元データの出典・加工した旨・加工した主体（PDL1.0 1.1.2・CC BY 4.0 3(a)）と、列の説明。
README = f"""RideCompass derived database / RideCompass 派生データベース

This database contains information from OpenStreetMap (https://www.openstreetmap.org/copyright),
which is made available here under the Open Database License (ODbL) 1.0:
https://opendatacommons.org/licenses/odbl/1-0/
© OpenStreetMap contributors

The database as a whole is made available under the ODbL 1.0. It also contains values made from the
following sources, which were processed by RideCompass:
- 地理院タイル（標高タイル）を加工して作成（国土地理院、https://maps.gsi.go.jp/development/ichiran.html）。勾配。
- 交通事故統計情報（警察庁、https://www.npa.go.jp/publications/statistics/koutsuu/opendata/index_opendata.html）を
  加工して作成。区間の周りの事故の件数を、区間の長さと収録の年数で割った値。
- 10m Annual Land Use Land Cover: Esri, Impact Observatory, Microsoft (CC BY 4.0,
  https://creativecommons.org/licenses/by/4.0/)。区間の周りの土地被覆の割合に加工。
These processed values are not made by, and are not endorsed by, the original providers.
加工した値は、元データの提供元が作成したものではありません。

{DATA_FILE}: one row per road segment (a way that has no segment is one row for the whole way).
Coordinates are EPSG:4326 (WKT). Columns:
- osm_way_id, segment_index: the OSM way and the segment along it (empty for a whole way)
- length_m: length in metres
- name, ref: OSM name / ref
- geometry_wkt: shape of the segment
- the other columns: per-road values (materials). An empty cell means no value.
{chr(10).join(_material_line(material_id) for material_id in DERIVED_DATABASE_MATERIAL_IDS)}
Weather values (wind, rain) and human-set calibration values are not included.
"""

#: 置き場の名前の形の署名。列・値式・表示を変えたコードは、同じ世代でも別の名前に書く。
EXPORT_SHAPE = shape_digest(DERIVED_DATABASE_ROWS_SQL, COLUMNS, README)

_FILE_PATTERN = re.compile(r"^ridecompass-derived-database-(?P<shape>[0-9a-f]+)-r(?P<derived>\d+|x)-i(?P<imported>\d+)\.zip$")
_STREAM_CHUNK = 20_000
#: 書く間もこれより空きが減ったら止める。置き場はホストのディレクトリ（キャッシュ・道路網の置き場と同じディスク）で、
#: 書き出しで埋めると backend のキャッシュと道路網の作り直しが書けなくなる。
MIN_FREE_BYTES = 2 * 1024**3
_PROGRESS_INTERVAL_SECONDS = 30.0


def file_name(revisions: DataRevisions) -> str:
    derived = "x" if revisions.derived is None else revisions.derived
    return f"ridecompass-derived-database-{EXPORT_SHAPE}-r{derived}-i{revisions.imported}.zip"


def latest() -> Path | None:
    """置いてある書き出し（書き終えたもの）。置くのは1つだけなので、名前の形に合う最初のもの。無ければNone。"""
    for path in sorted(ROOT.glob("*.zip")):
        if _FILE_PATTERN.match(path.name) and path.is_file():
            return path
    return None


async def ensure_current(session: AsyncSession) -> Path:
    """今の世代・今の形の書き出しを置く。既にあれば書かない。"""
    repository = RoadGraphRepository(session)
    target = ROOT / file_name(await repository.get_data_revisions())
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
    accident_years = await repository.get_accident_years_covered()
    rows = 0
    started = last_progress = time.perf_counter()
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(README_FILE, README)
        with archive.open(DATA_FILE, "w", force_zip64=True) as raw, \
                io.TextIOWrapper(raw, encoding="utf-8", newline="") as data:
            writer = csv.writer(data)
            writer.writerow(COLUMNS)
            async for chunk in repository.stream_derived_database_rows(accident_years, _STREAM_CHUNK):
                writer.writerows(tuple(row._mapping[column] for column in COLUMNS) for row in chunk)
                rows += len(chunk)
                check_space()
                now = time.perf_counter()
                if now - last_progress >= _PROGRESS_INTERVAL_SECONDS:
                    last_progress = now
                    logger.info("派生データベースを書き出し中 行=%d 経過=%.0f秒", rows, now - started)
    return rows


def _require_free_space() -> None:
    free = shutil.disk_usage(ROOT).free
    if free < MIN_FREE_BYTES:
        raise OSError(f"置き場のディスクの空きが足りないので、派生データベースを書き出しません free={free}")


def _prune(keep: Path) -> None:
    """書き終えたもののうち、`keep`でないものを消す。"""
    for path in ROOT.glob("*.zip"):
        if path != keep and _FILE_PATTERN.match(path.name):
            path.unlink()
