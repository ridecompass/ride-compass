"""取込範囲全体の道路網（`domain/road_network.py: RoadNetwork`）を、組んで（`infrastructure/road_network_assembly.py`）ディスクへ置き、読む。

DBから組むと数分かかる。そのため組むのは派生の作り直し（`batch/derive_cli.py`。作り直した表を
入れ替える前に組み、入れ替えた直後に置く）とデプロイの前処理（`scripts/build_road_network.py`）だけで、
backendは置かれたものを読むだけにする。

置き場は`data/road_network/<形の署名>-r<派生データの世代>/`。中に配列ごとの`.npy`と、
配列でない値（語彙・列の並び・世代）を書いた`manifest.json`を置く。書き終えるまでは読み手が
拾わない名前（先頭が`.`）のディレクトリに書き、最後に名前を付け替える——途中で落ちても、読む側が
書きかけを掴まない。

形の署名（`NETWORK_SHAPE`）は、配列の中身と置き場の書き方を決めるコードから導く。それらを変えたコードをデプロイすると
署名が変わり、古い置き場は選ばれなくなる。
"""

import inspect
import json
import logging
import math
import os
import re
import shutil
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import fields
from pathlib import Path
from typing import Any

import numpy as np
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import app.domain.elevation_profile
import app.domain.road_network_build
import app.domain.traffic_regulation
from app.domain.attributes import CategoricalColumn, EdgeMaterialArrays
from app.domain.geo import bearings_between
from app.domain.material_catalog import MATERIAL_CATALOG, material_array_columns
from app.domain.road_network import RoadNetwork, positions_in
from app.domain.search_graph import EDGE_VALUE_DTYPE, range_positions, run_starts
from app.domain.traffic import HIGHWAY_RANK, highway_rank, travel_allowed
from app.infrastructure import road_network_assembly
from app.infrastructure.cache_identity import shape_digest
from app.infrastructure.container_memory import memory_note
from app.infrastructure.data_paths import DATA_DIR
from app.infrastructure.road_graph_repository import NETWORK_SQL_SOURCES, RoadGraphRepository, float_array

logger = logging.getLogger("ridecompass.road_network")

#: 本番の読み手はこのファイルだけだが、テストがディスク（プロセス境界）の置き場を一時ディレクトリへ差し替えるために公開する
#: （testing.md「確かめる高さ」の (c)）。
ROOT = DATA_DIR / "road_network"

_MANIFEST = "manifest.json"
_DIRECTORY_PATTERN = re.compile(r"^(?P<shape>[0-9a-f]+)-r(?P<revision>\d+)$")
#: 置き場の配列を書くとき、ページキャッシュを手放すまでに書く大きさ。
_WRITE_CHUNK_BYTES = 64 * 2**20


def directory_name(revision: int) -> str:
    return f"{NETWORK_SHAPE}-r{revision}"


def _directories() -> Iterator[tuple[Path, re.Match[str]]]:
    """置き場の名前の形をしたディレクトリと、名前の照合の結果（書きかけは名前の形に合わないので含まない）。"""
    for path in ROOT.glob("*"):
        match = _DIRECTORY_PATTERN.match(path.name)
        if match is not None and path.is_dir():
            yield path, match


def _latest_directory() -> Path:
    """形の署名が一致するもののうち、世代が最も新しい置き場。"""
    candidates = (
        (int(match["revision"]), path)
        for path, match in _directories()
        if match["shape"] == NETWORK_SHAPE
    )
    return max(candidates, key=lambda candidate: candidate[0])[1]


def save(network: RoadNetwork) -> Path:
    """置き場を作って書き、同じ形で世代の古い置き場を消す。同じ世代の置き場が既にあれば書かずにそれを返す。"""
    return placed(network.revision) or publish(write_pending(network))


def placed(revision: int) -> Path | None:
    """今の形で`revision`の世代の置き場。無ければNone。"""
    target = ROOT / directory_name(revision)
    return target if target.exists() else None


def write_pending(network: RoadNetwork) -> Path:
    """読み手（`_latest_directory`）が拾わない名前で書き、そのディレクトリを返す。`publish`で世代の名前にする。"""
    with _new_pending(network.revision) as temporary:
        values: dict[str, object] = {}
        for f in fields(network):
            value = getattr(network, f.name)
            if isinstance(value, np.ndarray):
                _write_array(temporary / f"{f.name}.npy", value)
            else:
                values[f.name] = value
        _write_manifest(temporary, values)
    return temporary


@contextmanager
def _new_pending(revision: int) -> Iterator[Path]:
    """読み手の拾わない名前のディレクトリを作って渡す。中で落ちたら消す——呼び手は受け取る前なので消せず、
    片付け（`prune`・`prune_other_shapes`）も名前の形に合わないものを拾わない。"""
    ROOT.mkdir(parents=True, exist_ok=True)
    temporary = ROOT / f".{directory_name(revision)}.tmp-{os.getpid()}"
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.mkdir()
    try:
        yield temporary
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def _write_array(path: Path, value: np.ndarray) -> None:
    """`value`を`.npy`として書く。上限付きのコンテナでは、書いたファイルのページキャッシュもコンテナのメモリに数えられ、
    書き戻しより速く溜まると、道路網を丸ごと持った上限の中で強制終了される。そのため一定の大きさごとに書き戻して手放す
    （`np.save`は1本を一度に書き、途中で手放せない）。"""
    header = np.lib.format.header_data_from_array_1_0(value)
    header["fortran_order"] = False
    rows = max(1, _WRITE_CHUNK_BYTES // max(1, value.itemsize * math.prod(value.shape[1:])))
    with path.open("wb") as file:
        np.lib.format.write_array_header_1_0(file, header)
        for start in range(0, len(value), rows):
            file.write(np.ascontiguousarray(value[start:start + rows]).data)
            file.flush()
            os.fsync(file.fileno())
            if hasattr(os, "posix_fadvise"):  # Windowsの開発機には無い（手放さずに書くだけになる）
                os.posix_fadvise(file.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)


def _write_manifest(directory: Path, values: dict[str, object]) -> None:
    (directory / _MANIFEST).write_text(json.dumps(values, ensure_ascii=False), encoding="utf-8")


def _read_manifest(directory: Path) -> dict[str, Any]:
    return json.loads((directory / _MANIFEST).read_text(encoding="utf-8"))


def publish(pending: Path) -> Path:
    """`write_pending`が書いたものを世代の名前へ付け替え、同じ形で世代の古い置き場を消す。"""
    revision = _read_manifest(pending)["revision"]
    target = ROOT / directory_name(revision)
    pending.rename(target)
    for removed in prune(target):
        logger.info("古い道路網の置き場を消しました %s", removed.name)
    logger.info("道路網の置き場を作りました %s %s", target.name, memory_note())
    return target


def load(directory: Path) -> RoadNetwork:
    """置き場を読む。配列はメモリマップで開く——常に要る列だけがメモリに載る。"""
    values = _read_manifest(directory)
    arguments: dict[str, object] = {}
    for f in fields(RoadNetwork):
        if f.name in values:
            arguments[f.name] = _as_tuples(values[f.name])
        else:
            arguments[f.name] = np.load(directory / f"{f.name}.npy", mmap_mode="r", allow_pickle=False)
    return RoadNetwork(**arguments)  # type: ignore[arg-type]


#: 読み込み済みの置き場とその中身。プロセスの中で全リクエストが共有する（読み取り専用）。
_loaded: tuple[Path, RoadNetwork] | None = None


def current() -> RoadNetwork:
    """今の形の署名で世代が最も新しい置き場の中身。

    呼ぶたびに置き場を見て、読み込み済みより新しいもの（バッチが作り直した）があれば読み直す。
    読むのはメモリマップを開くだけなので、見るたびの費用はディレクトリの一覧程度に収まる。
    """
    global _loaded
    latest = _latest_directory()
    if _loaded is None or _loaded[0] != latest:
        _loaded = latest, load(latest)
        logger.info("道路網を読みました %s 有向の区間=%d", _loaded[0].name, _loaded[1].edge_count)
    return _loaded[1]


def _as_tuples(value: object) -> object:
    """JSONの配列をtupleへ戻す（`RoadNetwork`の語彙・列の並びはtupleで持つ）。"""
    if isinstance(value, list):
        return tuple(_as_tuples(item) for item in value)
    return value


def prune(keep: Path) -> list[Path]:
    """今の形の署名で、`keep`でない世代の置き場を消す（消したものを返す）。

    形の署名が違う置き場は消さない——デプロイの前処理が新しい署名の置き場を作る間も、
    古いコンテナは古い署名の置き場を読んでいる。
    """
    removed = []
    for path, match in _directories():
        if path == keep or match["shape"] != NETWORK_SHAPE:
            continue
        shutil.rmtree(path, ignore_errors=True)
        removed.append(path)
    return removed


def prune_other_shapes() -> int:
    """今のコードの形の署名でない置き場を消し、解放したバイト数を返す。

    backendの起動後に呼ぶ——デプロイで入れ替わるまでは、旧コンテナが古い署名の置き場を読んでいる。
    """
    freed = 0
    for path, match in _directories():
        if match["shape"] == NETWORK_SHAPE:
            continue
        freed += sum(f.stat().st_size for f in path.iterdir() if f.is_file())
        shutil.rmtree(path, ignore_errors=True)
        logger.info("古い形の道路網の置き場を消しました %s", path.name)
    return freed


async def ensure_current(session_factory: async_sessionmaker[AsyncSession]) -> Path:
    """今の派生データの世代・今の形の置き場を用意する。既にあれば作らない。"""
    async with session_factory() as session:
        repository = RoadGraphRepository(session)
        revision = (await repository.get_data_revisions()).derived
        target = placed(revision)
        if target is not None:
            logger.info("道路網の置き場は作成済みです %s", target.name)
            return target
        network = await road_network_assembly.build(repository, revision)
    return save(network)


#: 署名には、配列の中身を決めるコードの全文を入れる——組み方を直したのに署名が変わらないと、直す前のコードで組んだ置き場を
#: 読み続ける。中身を決めないコード（このファイルの置き場を選ぶ・掃除する所等）を入れると、関係の無い変更でもデプロイが
#: 組み直す。入れるのは、組むモジュールと事実から値を導くモジュールの全文と、それらが外から呼ぶ関数・型・値と、
#: 置き場の書き方・読み方。組む所から新しく外の関数を呼んだら、ここへ足す。
NETWORK_SHAPE = shape_digest(
    RoadNetwork, *NETWORK_SQL_SOURCES, HIGHWAY_RANK, material_array_columns(), EDGE_VALUE_DTYPE,
    [(MATERIAL_CATALOG[material_id].dtype, MATERIAL_CATALOG[material_id].per_km, MATERIAL_CATALOG[material_id].value_labels)
     for material_id in sum(material_array_columns(), ())], *(
        inspect.getsource(code) for code in (
            road_network_assembly, app.domain.road_network_build, app.domain.elevation_profile,
            app.domain.traffic_regulation,
            RoadGraphRepository.get_network_regulations, bearings_between, run_starts, range_positions,
            highway_rank, travel_allowed, positions_in, EdgeMaterialArrays, CategoricalColumn.encode, float_array,
            RoadGraphRepository.stream_network_nodes, RoadGraphRepository.stream_network_edges,
            RoadGraphRepository.get_network_tuning, RoadGraphRepository.get_edge_material_arrays,
            RoadGraphRepository.get_edge_elevation_profiles, write_pending, load, _as_tuples)))
