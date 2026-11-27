import asyncio
import logging
from collections.abc import Mapping, Sequence

from app.domain.stopwatch import elapsed_ms, start_timer
from app.domain.errors import SearchAreaTooLargeError, SearchMemoryBusyError
from app.domain.geo import LatLon
from app.domain.graph import parse_edge_id
from app.domain.region import BoundingBox, tiles_covering_bbox
from app.domain.attributes import CategoricalColumn
from app.domain.cost_axes import Burden
from app.domain.leg_costs import burden_fills
from app.domain.road_classes import RoadClassDefinitions
from app.domain.road_network import (
    RoadNetwork,
    RoadSlice,
    bbox_covering_edges,
    network_material_column,
    road_class_columns,
    slice_network,
)
from app.domain.model_settings import ModelSettings, current_model_settings
from app.domain.route_search import DETOUR_RATIO_SHARING_ZOOM
from app.infrastructure import container_memory, road_network_store
from app.infrastructure.detour_ratio_cache import TileSet

logger = logging.getLogger("ridecompass.graph")

#: 生成以外（地図タイルの配信・プロセスの常駐分と、生成のあとに返しきれずに残る領域）のために取り置くメモリ。
RESERVED_BYTES = 2 * 1024**3
#: 1件の生成が、切り出した有向の区間1本あたりに使うメモリ（探索用グラフ・コスト配列・ターン構造・候補の評価の合計）。
BYTES_PER_EDGE = 1100


class SearchMemory:
    """同時に動く生成どうしが分け合う、生成に回せるメモリ（コンテナのメモリ上限から取り置きを引いた分）。

    プロセスに1つ置き、生成ごとの`GraphService`へ渡す。上限を超えるとプロセスごと落ち、全員の生成と地図が止まるので、
    生成は切り出した区間の数に比例する分を組む前に取り、終わったら返す。数えるのはイベントループの中だけで、
    確かめてから足すまでに`await`を挟まない（別のスレッドから呼ぶとほかの生成の分と競う）。
    """

    def __init__(self) -> None:
        self._in_use = 0

    def reserve(self, edges: int) -> int:
        """区間`edges`本の生成の分を取り、取ったバイト数を返す。コンテナのメモリ上限が無ければ取らない（0、断らない）。

        生成に回せる全部へ1件でも収まらなければ`SearchAreaTooLargeError`、ほかの生成の分と合わせて収まらなければ
        `SearchMemoryBusyError`を送出する。
        """
        limit = container_memory.memory_limit_bytes()
        if limit is None:
            return 0
        budget = max(0, limit - RESERVED_BYTES)
        needed = edges * BYTES_PER_EDGE
        if needed > budget:
            raise SearchAreaTooLargeError(edges, budget // BYTES_PER_EDGE)
        if self._in_use + needed > budget:
            raise SearchMemoryBusyError(edges, (budget - self._in_use) // BYTES_PER_EDGE)
        self._in_use += needed
        return needed

    def release(self, reserved: int) -> None:
        """`reserve`が返したバイト数を返す。"""
        self._in_use -= reserved


#: 最後に作った区分の列と、作ったときの道路網・区分の全体。どちらかが入れ替わったら作り直す。
_classes: tuple[RoadNetwork, RoadClassDefinitions, tuple[dict[str, CategoricalColumn], dict[str, CategoricalColumn]]] | None = None


def network_classes(network: RoadNetwork, definitions: RoadClassDefinitions
                    ) -> tuple[dict[str, CategoricalColumn], dict[str, CategoricalColumn]]:
    """取込範囲全体の、区分`definitions`の列と層ごとの値。道路網と区分の組ごとに1回だけ作り、組が替わったら丸ごと入れ替える。

    別のスレッドが同時に作り直しても、どちらも同じ組から同じ列を作るだけなので、束縛の差し替えは1回で済ませる。"""
    global _classes
    cached = _classes
    if cached is not None and cached[0] is network and cached[1] is definitions:
        return cached[2]
    started = start_timer()
    columns = road_class_columns(network, definitions)
    logger.info("road_class_columns edges=%d classifications=%d ms=%d",
                network.edge_count, len(definitions.classifications), elapsed_ms(started))
    _classes = (network, definitions, columns)
    return columns


#: 最後に求めた道のストレスの重さの平均と、求めたときの道路網・区分の列・道のストレスの軸の費目（軸id→`burden`）。どれかが
#: 入れ替わったら求め直す。費目だけを鍵にするので、軸の名前・色・レンズの段を直しても求め直さない。
_burden_fills: tuple[RoadNetwork, Mapping[str, CategoricalColumn], dict[str, Burden], dict[str, float]] | None = None


def network_burden_fills(network: RoadNetwork, settings: ModelSettings) -> dict[str, float]:
    """写し`settings`の道のストレスの軸id→材料の欠けた区間を埋める、取込範囲全体の重さの平均（`domain/leg_costs.py:
    burden_fills`）。全区間を数えるので、道路網・区分の列・道のストレスの軸の費目の組ごとに1回だけ求める。"""
    global _burden_fills
    classes = network_classes(network, settings.road_classes)[0]
    burdens = {axis_id: axis.burden for axis_id, axis in settings.cost_axes.burden.items()}
    cached = _burden_fills
    if cached is not None and cached[0] is network and cached[1] is classes and cached[2] == burdens:
        return cached[3]
    columns = {burden.material: network_material_column(network, classes, burden.material) for burden in burdens.values()}
    fills = burden_fills(burdens, columns, network.distance_m)
    _burden_fills = (network, classes, burdens, fills)
    return fills


def warm_road_network() -> None:
    """道路網の置き場が入れ替わっていれば読み直し、取込範囲全体の区分の列と道のストレスの軸の欠けを埋める平均を求めておく。
    全区間を数えるので、スレッドから呼ぶ。"""
    network_burden_fills(road_network_store.current(), current_model_settings())


def _slice(network: RoadNetwork, bbox: BoundingBox, road_classes: RoadClassDefinitions) -> RoadSlice:
    return slice_network(
        network, network_classes(network, road_classes),
        bbox.min_longitude, bbox.min_latitude, bbox.max_longitude, bbox.max_latitude,
    )


class GraphService:
    """探索範囲の道路網を、取込範囲全体の配列（`infrastructure/road_network_store.py`）から
    切り出す。**読むだけで、作らない。** DB は読まない。

    道路網は取込範囲の中にしか無いので、取込範囲の外は区間が0本の切り出しになる。
    作ったときに渡した道路網だけを切り出す（切り出しのたびに置き場を読み直さない）。
    """

    def __init__(self, memory: SearchMemory, network: RoadNetwork):
        self._memory = memory
        self._network = network
        self._reserved = 0


    def release_search_memory(self) -> None:
        """`get_search_slice`が取った生成のメモリを返す。生成が終わったら（組んだ配列を捨てたら）呼ぶ。"""
        self._memory.release(self._reserved)
        self._reserved = 0

    async def get_search_slice(self, bbox: BoundingBox, road_classes: RoadClassDefinitions) -> tuple[RoadSlice, TileSet]:
        """探索範囲の区間を、区分`road_classes`の列とともに返す。返したら、その区間の数に比例する生成のメモリを`release_search_memory`まで取っておく。

        切り出すのはbboxそのもの。あわせて返すbboxを覆うz12タイルの集合は、近い範囲をまとめて
        指す鍵として使う（学習した迂回率の鍵）。
        """
        started = start_timer()
        tiles = tiles_covering_bbox(bbox, DETOUR_RATIO_SHARING_ZOOM)
        # 全区間を走査するので、イベントループの外で切り出す。
        road = await asyncio.to_thread(_slice, self._network, bbox, road_classes)
        try:
            self._reserved += self._memory.reserve(road.edge_count)
        except (SearchAreaTooLargeError, SearchMemoryBusyError) as exc:
            logger.warning(
                "探索範囲の区間がメモリに収まらないため使わない bbox=(%.2f,%.2f,%.2f,%.2f) tiles=%d %s",
                bbox.min_latitude, bbox.min_longitude, bbox.max_latitude, bbox.max_longitude, len(tiles), exc)
            raise
        logger.info(
            "get_search_slice tiles=%d edges=%d nodes=%d slice_ms=%d",
            len(tiles), road.edge_count, road.node_count, elapsed_ms(started),
        )
        tile_set = frozenset((DETOUR_RATIO_SHARING_ZOOM, x, y) for x, y in tiles)
        return road, tile_set

    def bbox_covering(self, points: Sequence[LatLon], edge_ids: Sequence[str], margin_km: float) -> BoundingBox:
        """`points`と、区間の鍵の列`edge_ids`の区間を覆う探索の矩形（`domain/road_network.py: bbox_covering_edges`）。
        形の合わない鍵と道路網に無い区間は飛ばす。"""
        edges = [parsed for edge_id in edge_ids if (parsed := parse_edge_id(edge_id)) is not None]
        return bbox_covering_edges(self._network, points, edges, margin_km)
