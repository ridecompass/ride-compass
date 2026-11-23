"""取込範囲全体の道路網（`domain/road_network.py: RoadNetwork`）をDBから作り、ディスクへ置き、読む。

DBから作ると数分かかる。そのため作るのは派生の作り直し（`batch/derive_cli.py`。作り直した表を
入れ替える前に作り、入れ替えた直後に置く）とデプロイの前処理（`scripts/build_road_network.py`）だけで、
backendは置かれたものを読むだけにする。

置き場は`data/road_network/<形の署名>-r<派生データの世代>/`。中に配列ごとの`.npy`と、
配列でない値（語彙・列の並び・世代）を書いた`manifest.json`を置く。書き終えるまでは読み手が
拾わない名前（先頭が`.`）のディレクトリに書き、最後に名前を付け替える——途中で落ちても、読む側が
書きかけを掴まない。

形の署名は`RoadNetwork`の列と、読み出しのSQL（材料の式を含む）と、配列を組むときに通るコードの全文から導く（`NETWORK_SHAPE`）。
材料の式や組み方を変えたコードをデプロイすると署名が変わり、古い置き場は選ばれなくなる。
"""

import inspect
import json
import logging
import os
import re
import shutil
import sys
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import fields
from pathlib import Path
from typing import Any

import numpy as np
import shapely
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.domain.attributes import EDGE_ROW_ARRAY_FIELDS, CategoricalColumn, EdgeMaterialArrays
import app.domain.elevation_profile
import app.domain.road_network_build
from app.domain.geo import bearings_between
from app.domain.material_catalog import material_array_columns
from app.domain.road_network import RoadNetwork, positions_in
from app.domain.road_network_build import EdgelessWays, build_road_network
from app.domain.search_graph import run_starts
from app.domain.traffic import HIGHWAY_RANK, highway_rank, travel_allowed
from app.domain.tuning import STOP_CLUSTER_DISTANCE_ID
from app.infrastructure.cache_identity import shape_digest
from app.infrastructure.data_paths import DATA_DIR
from app.infrastructure.road_graph_repository import NETWORK_SQL_SOURCES, RoadGraphRepository, float_array

logger = logging.getLogger("ridecompass.road_network")

#: 本番の読み手はこのファイルだけだが、テストがディスク（プロセス境界）の置き場を一時ディレクトリへ差し替えるために公開する
#: （testing.md「確かめる高さ」の (c)）。
ROOT = DATA_DIR / "road_network"

#: 署名には、配列を組むときに通るコードの全文を入れる——組み方を直したのに署名が変わらないと、直す前のコードで組んだ置き場を
#: 読み続ける。このファイル（つながり・形・階級・向きを組む所と、材料と断面を詰める所）・事実から値を導く2つのモジュール・
#: それらが呼ぶ関数と、DBの行を配列にする読み出しの関数。
NETWORK_SHAPE = shape_digest(RoadNetwork, *NETWORK_SQL_SOURCES, HIGHWAY_RANK, material_array_columns(), *(
    inspect.getsource(code) for code in (
        sys.modules[__name__], app.domain.road_network_build, app.domain.elevation_profile, bearings_between,
        highway_rank, travel_allowed, positions_in, EdgeMaterialArrays, CategoricalColumn.encode, float_array,
        RoadGraphRepository.get_edgeless_ways, RoadGraphRepository.stream_network_nodes, RoadGraphRepository.stream_network_edges,
        RoadGraphRepository.get_network_tuning, RoadGraphRepository.get_edge_material_arrays,
        RoadGraphRepository.get_edge_elevation_profiles)))

_MANIFEST = "manifest.json"
_DIRECTORY_PATTERN = re.compile(r"^(?P<shape>[0-9a-f]+)-r(?P<revision>\d+)$")
# 行を流す単位と、材料を1回で引く区間の数。材料は区間ごとに列の値を作るため、1回ぶんの
# 一時的なメモリがこの数に比例する。
_STREAM_CHUNK = 200_000
_MATERIAL_BATCH = 200_000


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
                np.save(temporary / f"{f.name}.npy", value, allow_pickle=False)
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
    logger.info("道路網の置き場を作りました %s", target.name)
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
        network = await build(repository, revision)
    return save(network)


async def build(repository: RoadGraphRepository, revision: int) -> RoadNetwork:
    """DBから道路網全体の事実を読み、`revision`の世代の`RoadNetwork`を組む（`domain/road_network_build.py`）。較正値は、読む表を
    作り直したときに使った値で読む。"""
    started = time.monotonic()
    nodes = await _read_nodes(repository)
    tuning = await repository.get_network_tuning()
    edges, dropped_without_endpoint = await _read_directed_edges(repository, nodes["node_osm_id"], tuning)
    topology_s = time.monotonic() - started
    logger.info(
        "道路網のつながりを読みました ノード=%d 有向の区間=%d 端点のノードが無く落とした有向の区間=%d %.0f秒",
        len(nodes["node_osm_id"]), len(edges["edge_way_id"]), dropped_without_endpoint, topology_s,
    )

    materials = await _read_materials(repository, edges["edge_way_id"], edges["edge_segment"], edges["edge_forward"],
                                      await repository.get_edgeless_ways())
    read_s = time.monotonic() - started
    logger.info("道路網の材料を読みました 有向の区間=%d %.0f秒", len(edges["edge_way_id"]), read_s - topology_s)
    network = build_road_network(revision=revision, stop_cluster_distance_m=tuning[STOP_CLUSTER_DISTANCE_ID],
                                 **nodes, **edges, **materials)
    logger.info("道路網の配列を組みました %.0f秒", time.monotonic() - started - read_s)
    return network


#: `RoadNetwork`の欄 → (ノードの行の列, 型)。
_NODE_COLUMNS = {
    "node_osm_id": ("osm_node_id", np.int64), "node_lat": ("latitude", np.float64),
    "node_lon": ("longitude", np.float64), "node_has_signals": ("has_traffic_signals", np.bool_),
    "node_branch_count": ("branch_count", np.int16),
}
#: 有向の区間の欄 → 型。
_EDGE_DTYPES = {"edge_way_id": np.int64, "edge_segment": np.int32, "edge_forward": np.bool_, "edge_from": np.int32,
                "edge_to": np.int32, "edge_rank": np.int8, "edge_start_bearing_deg": np.float64,
                "edge_end_bearing_deg": np.float64, "edge_shape_start": np.int64, "edge_shape_points": np.int32}
_BEARING_COLUMNS = ("start_bearing_deg", "end_bearing_deg", "reverse_start_bearing_deg", "reverse_end_bearing_deg")


async def _read_nodes(repository: RoadGraphRepository) -> dict[str, Any]:
    chunks: dict[str, list[np.ndarray]] = {name: [] for name in _NODE_COLUMNS}
    async for rows in repository.stream_network_nodes(_STREAM_CHUNK):
        for name, (column, dtype) in _NODE_COLUMNS.items():
            chunks[name].append(np.fromiter((getattr(r, column) for r in rows), dtype=dtype, count=len(rows)))
    return {name: _concatenate(parts, _NODE_COLUMNS[name][1]) for name, parts in chunks.items()}


async def _read_directed_edges(
    repository: RoadGraphRepository, node_osm_id: np.ndarray, tuning: Mapping[str, float]
) -> tuple[dict[str, Any], int]:
    """区間を有向の行へ広げ、有向の区間の欄と区間の形（`shape_lon`・`shape_lat`）と、端点のノードが無く落とした有向の行の数を
    返す。一方通行は走れる向きだけを持つ（道の値の行は、区間が持つ外部キーが保証する）。形は有向の行が残った区間の分だけ、
    区間の順に隙間なく並べる。"""
    dropped_without_endpoint = 0
    shape_count = 0
    parts: dict[str, list[np.ndarray]] = {name: [] for name in (*_EDGE_DTYPES, "shape_lon", "shape_lat")}
    async for rows in repository.stream_network_edges(_STREAM_CHUNK, tuning):
        n = len(rows)
        way = np.fromiter((r.osm_way_id for r in rows), dtype=np.int64, count=n)
        segment = np.fromiter((r.segment_index for r in rows), dtype=np.int32, count=n)
        from_osm = np.fromiter((r.from_node_id for r in rows), dtype=np.int64, count=n)
        to_osm = np.fromiter((r.to_node_id for r in rows), dtype=np.int64, count=n)
        rank = np.fromiter((highway_rank(r.highway) for r in rows), dtype=np.int8, count=n)
        # 方位は2点が同じならNULLで、NaNとして読む。
        bearings = {name: np.fromiter((np.nan if (v := getattr(r, name)) is None else v for r in rows),
                                      dtype=np.float64, count=n)
                    for name in _BEARING_COLUMNS}

        # 区間ごとに順方向・逆方向の2行を並べ、走れない向きを落とす。
        keep = np.fromiter((ok for r in rows for ok in travel_allowed(r.direction)), dtype=bool, count=2 * n)
        is_forward = np.tile([True, False], n)[keep]
        source = np.repeat(np.arange(n), 2)[keep]
        tail = np.where(is_forward, from_osm[source], to_osm[source])
        head = np.where(is_forward, to_osm[source], from_osm[source])
        tail_row, head_row = positions_in(node_osm_id, tail), positions_in(node_osm_id, head)
        found = (tail_row >= 0) & (head_row >= 0)
        dropped_without_endpoint += int((~found).sum())
        source, is_forward = source[found], is_forward[found]

        coordinates, owner = shapely.get_coordinates(shapely.from_wkb([bytes(r.wkb) for r in rows]), return_index=True)
        used = np.zeros(n, dtype=bool)
        used[source] = True
        kept_points = used[owner]
        points = np.bincount(owner[kept_points], minlength=n).astype(np.int32)
        starts = shape_count + np.cumsum(points, dtype=np.int64) - points
        shape_count += int(points.sum())

        parts["edge_way_id"].append(way[source])
        parts["edge_segment"].append(segment[source])
        parts["edge_forward"].append(is_forward)
        parts["edge_from"].append(tail_row[found].astype(np.int32))
        parts["edge_to"].append(head_row[found].astype(np.int32))
        parts["edge_rank"].append(rank[source])
        for end in ("start", "end"):
            parts[f"edge_{end}_bearing_deg"].append(np.where(
                is_forward, bearings[f"{end}_bearing_deg"][source], bearings[f"reverse_{end}_bearing_deg"][source]))
        parts["edge_shape_start"].append(starts[source])
        parts["edge_shape_points"].append(points[source])
        parts["shape_lon"].append(coordinates[kept_points, 0])
        parts["shape_lat"].append(coordinates[kept_points, 1])

    result: dict[str, Any] = {name: _concatenate(values, _EDGE_DTYPES.get(name, np.float64))
                              for name, values in parts.items()}
    return result, dropped_without_endpoint


async def _read_materials(
    repository: RoadGraphRepository, way: np.ndarray, segment: np.ndarray, forward: np.ndarray, way_ids: list[int]
) -> dict[str, Any]:
    """材料は`get_edge_material_arrays`で引く。区間を持たない道`way_ids`の材料も同じ読み出しで、区間の無い道の値として引き
    （区間の値の表は値を持たない）、区間の材料のあとに続けて詰めてから分ける（分類の語彙を区間と1つにする）。"""
    edge_count = len(way)
    accident_years_covered = await repository.get_accident_years_covered()
    columns = MaterialColumns(edge_count + len(way_ids))
    batches = [(way[start:start + _MATERIAL_BATCH].tolist(), segment[start:start + _MATERIAL_BATCH].tolist(),
                forward[start:start + _MATERIAL_BATCH].tolist()) for start in range(0, edge_count, _MATERIAL_BATCH)]
    batches += [(way_ids[start:start + _MATERIAL_BATCH], [-1] * len(way_ids[start:start + _MATERIAL_BATCH]),
                 [True] * len(way_ids[start:start + _MATERIAL_BATCH])) for start in range(0, len(way_ids), _MATERIAL_BATCH)]
    for ways, segments, forwards in batches:
        columns.add(await repository.get_edge_material_arrays(ways, segments, forwards, accident_years_covered))
        logger.info("材料 %d/%d", columns.filled, edge_count + len(way_ids))
    result = columns.result()
    numeric, codes = result.pop("numeric_values"), result.pop("categorical_codes")
    return {
        **{name: values[:edge_count] if isinstance(values, np.ndarray) else values for name, values in result.items()},
        "numeric_values": numeric[:edge_count], "categorical_codes": codes[:edge_count],
        "edgeless": EdgelessWays(np.asarray(way_ids, dtype=np.int64), numeric[edge_count:], codes[edge_count:]),
        **await _read_profiles(repository, way, segment),
    }


async def _read_profiles(repository: RoadGraphRepository, way: np.ndarray, segment: np.ndarray) -> dict[str, Any]:
    """区間の断面の点（`RoadNetwork`の`edge_profile_*`・`profile_*`の欄）。点は区間ごとに1回だけ持ち、同じ区間の両向きの行
    （有向の行は区間ごとに隣り合って並ぶ）は同じ点を指す。"""
    first = run_starts(way) | run_starts(segment)
    owner = np.cumsum(first) - 1  # 行 → 点を持つ区間の番号
    unique_rows = np.flatnonzero(first)
    profiles = await repository.get_edge_elevation_profiles(way[unique_rows].tolist(), segment[unique_rows].tolist())
    points = np.fromiter((len(elevation) for elevation, _ in profiles), dtype=np.int32, count=len(profiles))
    starts = np.cumsum(points, dtype=np.int64) - points
    return {
        "edge_profile_start": starts[owner], "edge_profile_points": points[owner],
        "profile_elevation_m": _concatenate([elevation for elevation, _ in profiles], np.float32),
        "profile_position": _concatenate([position for _, position in profiles], np.float32),
    }


class MaterialColumns:
    """区間の束ごとに引いた材料を、道路網全体の配列へ引いた順に詰める。

    書き込み先の配列を最初の束で確保して埋める——束ごとの配列を最後に連結すると、全体ぶんを
    2度持つ瞬間ができる。分類の材料は束ごとに語彙が違うので、道路網全体の語彙の番号へ付け替える。
    """

    def __init__(self, edge_count: int):
        self._edge_count = edge_count
        self._filled = 0
        self._arrays: dict[str, np.ndarray] = {}
        self._vocab: list[dict[str | None, int]] = []
        self._ids: dict[str, tuple[str, ...]] = {}

    @property
    def filled(self) -> int:
        """詰めた行の数。"""
        return self._filled

    def add(self, materials: EdgeMaterialArrays) -> None:
        """次の束を、前の束の続きの行へ詰める。"""
        if not self._arrays:
            self._ids = {"numeric_ids": materials.numeric_ids, "categorical_ids": materials.categorical_ids}
            self._vocab = [{None: 0} for _ in materials.categorical_ids]
            self._arrays["categorical_codes"] = np.zeros(
                (self._edge_count, len(materials.categorical_ids)), dtype=np.int16)
            for name in EDGE_ROW_ARRAY_FIELDS:
                value = getattr(materials, name)
                self._arrays[name] = np.empty((self._edge_count, *value.shape[1:]), dtype=value.dtype)
        start, stop = self._filled, self._filled + len(materials.distance_m)
        for name in EDGE_ROW_ARRAY_FIELDS:
            self._arrays[name][start:stop] = getattr(materials, name)
        for column, values in enumerate(materials.categorical_columns):
            codes = self._vocab[column]
            to_network_code = np.array([codes.setdefault(v, len(codes)) for v in values.vocab], dtype=np.int16)
            self._arrays["categorical_codes"][start:stop, column] = to_network_code[values.codes]
        self._filled = stop

    def result(self) -> dict[str, Any]:
        """`RoadNetwork`の材料の欄。"""
        return {
            **self._ids,
            **self._arrays,
            "categorical_vocab": tuple(tuple(sorted(codes, key=codes.__getitem__)) for codes in self._vocab),
        }




def _concatenate(parts: list[np.ndarray], dtype) -> np.ndarray:
    return np.concatenate(parts).astype(dtype, copy=False) if parts else np.zeros(0, dtype=dtype)
