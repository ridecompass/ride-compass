"""取込範囲全体の道路網（`domain/road_network.py: RoadNetwork`）を、DBの事実から組む（組み方は`domain/road_network_build.py`）。

このファイルの全文は配列の形の署名（`infrastructure/road_network_store.py: NETWORK_SHAPE`）に入るので、配列の中身を決めない
コード（置き場の読み書き・掃除）を置かない。
"""

import ctypes
import logging
import sys
import time
from collections.abc import Mapping
from typing import Any

import numpy as np
import shapely

from app.domain.attributes import EDGE_ROW_ARRAY_FIELDS, EdgeMaterialArrays
from app.domain.material_catalog import MATERIAL_CATALOG, PEDESTRIAN_ROAD
from app.domain.road_network import RoadNetwork, positions_in
from app.domain.road_network_build import build_road_network, per_km, regulation_arrays
from app.domain.search_graph import run_starts
from app.domain.traffic import highway_rank, travel_allowed
from app.domain.traffic_regulation import PEDESTRIAN_ROAD_VOCAB
from app.domain.tuning import MAX_PLAUSIBLE_GRADE_ID, STEEPEST_MIN_INTERVAL_ID
from app.infrastructure.container_memory import memory_note
from app.infrastructure.road_graph_repository import RoadGraphRepository

logger = logging.getLogger("ridecompass.road_network")

# 行を流す単位と、材料を1回で引く区間の数。材料は区間ごとに列の値を作るため、1回ぶんの
# 一時的なメモリがこの数に比例する。
_STREAM_CHUNK = 200_000
_MATERIAL_BATCH = 200_000


async def build(repository: RoadGraphRepository, revision: int) -> RoadNetwork:
    """DBから道路網全体の事実を読み、`revision`の世代の`RoadNetwork`を組む（`domain/road_network_build.py`）。較正値は、読む表を
    作り直したときに使った値で読む。"""
    started = time.monotonic()
    _return_large_buffers_at_once()
    nodes = await _read_nodes(repository)
    tuning = await repository.get_network_tuning()
    edges, dropped_without_endpoint = await _read_directed_edges(repository, nodes["node_osm_id"], tuning)
    _release_freed_memory()
    topology_s = time.monotonic() - started
    logger.info(
        "道路網のつながりを読みました ノード=%d 有向の区間=%d 端点のノードが無く落とした有向の区間=%d %.0f秒 %s",
        len(nodes["node_osm_id"]), len(edges["edge_way_id"]), dropped_without_endpoint, topology_s, memory_note(),
    )

    materials = await _read_materials(repository, edges["edge_way_id"], edges["edge_segment"], edges["edge_forward"])
    _release_freed_memory()
    read_s = time.monotonic() - started
    logger.info("道路網の材料を読みました 有向の区間=%d %.0f秒 %s", len(edges["edge_way_id"]), read_s - topology_s,
                memory_note())
    # 材料の値式は区間の量を返すので、1kmあたりにする材料（`MaterialSpec.per_km`）はここで区間の長さで割る（割り算は
    # `domain/road_network_build.py: per_km`の1か所）。
    for column, material_id in enumerate(materials["numeric_ids"]):
        if MATERIAL_CATALOG[material_id].per_km:
            materials["numeric_values"][:, column] = per_km(materials["numeric_values"][:, column], materials["distance_m"])
    regulation_fields, pedestrian_road = regulation_arrays(
        edges["edge_way_id"], edges["edge_segment"], await repository.get_network_regulations())
    column = materials["categorical_ids"].index(PEDESTRIAN_ROAD)
    materials["categorical_codes"][:, column] = pedestrian_road
    vocab = list(materials["categorical_vocab"])
    vocab[column] = PEDESTRIAN_ROAD_VOCAB
    materials["categorical_vocab"] = tuple(vocab)
    network = build_road_network(revision=revision, max_grade=tuning[MAX_PLAUSIBLE_GRADE_ID] / 100.0,
                                 steepest_min_interval_m=tuning[STEEPEST_MIN_INTERVAL_ID],
                                 **nodes, **edges, **materials, **regulation_fields)
    logger.info("道路網の配列を組みました %.0f秒 %s", time.monotonic() - started - read_s, memory_note())
    return network


def _release_freed_memory() -> None:
    """読み終えたDBの行の分を、OSへ返す。glibcのmallocは、捨てた小さな割り当ての分を返さずに抱え、上限付きのコンテナでは
    それも上限に数えられる。"""
    if sys.platform == "linux":
        ctypes.CDLL("libc.so.6").malloc_trim(0)


def _return_large_buffers_at_once() -> None:
    """このプロセスの以後の、境目より大きい割り当てをヒープの外に置かせ、捨てたらすぐOSへ返させる。glibcは既定では、大きな割り当てを
    捨てるたびに境目を引き上げるので、組む途中の数十MBの一時の配列がヒープに溜まって返されず、上限付きのコンテナではそれも上限に
    数えられる。境目を明示して置くと、引き上げが止まる。"""
    if sys.platform == "linux":
        ctypes.CDLL("libc.so.6").mallopt(-3, 128 * 1024)  # M_MMAP_THRESHOLDを、glibcの既定の初めの値に置く


#: `RoadNetwork`の欄 → (ノードの行の列, 型)。
_NODE_COLUMNS = {
    "node_osm_id": ("osm_node_id", np.int64), "node_lat": ("latitude", np.float64),
    "node_lon": ("longitude", np.float64), "node_signal_place": ("signal_place", np.int32),
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
    repository: RoadGraphRepository, way: np.ndarray, segment: np.ndarray, forward: np.ndarray
) -> dict[str, Any]:
    """材料は`get_edge_material_arrays`で引く。"""
    edge_count = len(way)
    columns = MaterialColumns(edge_count)
    for start in range(0, edge_count, _MATERIAL_BATCH):
        stop = start + _MATERIAL_BATCH
        columns.add(await repository.get_edge_material_arrays(
            way[start:stop].tolist(), segment[start:stop].tolist(), forward[start:stop].tolist()))
        logger.info("材料 %d/%d", columns.filled, edge_count)
    return {**columns.result(), **await _read_profiles(repository, way, segment)}


async def _read_profiles(repository: RoadGraphRepository, way: np.ndarray, segment: np.ndarray) -> dict[str, Any]:
    """区間の断面の点（`RoadNetwork`の`edge_profile_*`・`profile_*`の欄）。点は区間ごとに1回だけ持ち、同じ区間の両向きの行
    （有向の行は区間ごとに隣り合って並ぶ）は同じ点を指す。"""
    first = run_starts(way) | run_starts(segment)
    owner = np.cumsum(first) - 1  # 行 → 点を持つ区間の番号
    unique_rows = np.flatnonzero(first)
    points, elevation, position = await repository.get_edge_elevation_profiles(
        way[unique_rows].tolist(), segment[unique_rows].tolist())
    starts = np.cumsum(points, dtype=np.int64) - points
    return {"edge_profile_start": starts[owner], "edge_profile_points": points[owner],
            "profile_elevation_m": elevation, "profile_position": position}


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
