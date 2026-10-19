import asyncio
import logging
from collections.abc import Mapping

from app.domain.stopwatch import elapsed_ms, start_timer
from app.config import settings
from app.domain.errors import SearchAreaTooLargeError
from app.domain.graph import LeanEdge
from app.domain.region import BoundingBox, tiles_covering_bbox
from app.domain.attributes import CategoricalColumn
from app.domain.road_classes import RoadClassDefinitions, current_road_classes
from app.domain.road_network import RoadNetwork, RoadSlice, road_class_columns, slice_network
from app.domain.route_search import DETOUR_RATIO_SHARING_ZOOM
from app.domain.route_points import RoutePointHit
from app.infrastructure import container_memory, road_network_store
from app.infrastructure.detour_ratio_cache import TileSet
from app.infrastructure.road_graph_repository import RoadGraphRepository

logger = logging.getLogger("ridecompass.graph")

#: 生成以外（地図タイルの配信・プロセスの常駐分）のために取り置くメモリ。
_RESERVED_BYTES = 2 * 1024**3
#: 1件の生成が、切り出した有向の区間1本あたりに使うメモリ（探索用グラフ・コスト配列・ターン構造・候補の評価の合計）。
_BYTES_PER_EDGE = 1050


def _max_search_edges() -> int | None:
    """1回の生成が切り出してよい有向の区間の上限。コンテナのメモリ上限が無ければNone（断らない）。

    同時に動く生成（`generate_max_concurrent`）がそろって上限いっぱいの範囲を組んでも、取り置きを残して
    メモリ上限に収まる本数にする。上限を超えるとプロセスごと落ち、全員の生成と地図が止まる。
    """
    limit = container_memory.memory_limit_bytes()
    if limit is None:
        return None
    return max(0, (limit - _RESERVED_BYTES) // settings.generate_max_concurrent // _BYTES_PER_EDGE)


#: 最後に作った区分の列と、作ったときの道路網・区分の全体。どちらかが入れ替わったら作り直す。
_classes: tuple[RoadNetwork, RoadClassDefinitions, Mapping[str, CategoricalColumn]] | None = None


def _network_classes(network: RoadNetwork) -> Mapping[str, CategoricalColumn]:
    """取込範囲全体の区分の列。道路網と区分の全体の組ごとに1回だけ作り、組が替わったら丸ごと入れ替える。

    別のスレッドが同時に作り直しても、どちらも同じ組から同じ列を作るだけなので、束縛の差し替えは1回で済ませる。"""
    global _classes
    definitions = current_road_classes()
    cached = _classes
    if cached is not None and cached[0] is network and cached[1] is definitions:
        return cached[2]
    started = start_timer()
    columns = road_class_columns(network, definitions)
    logger.info("road_class_columns edges=%d classifications=%d ms=%d",
                network.edge_count, len(definitions.classifications), elapsed_ms(started))
    _classes = (network, definitions, columns)
    return columns


def _slice_current(bbox: BoundingBox) -> RoadSlice:
    network = road_network_store.current()
    return slice_network(
        network, _network_classes(network),
        bbox.min_longitude, bbox.min_latitude, bbox.max_longitude, bbox.max_latitude,
    )


class GraphService:
    """探索範囲の道路網を、取込範囲全体の配列（`infrastructure/road_network_store.py`）から
    切り出す。**読むだけで、作らない。**

    取込範囲の外はデータ未整備としてNoneを返す。カバレッジは取込の宣言
    （`source_runs.profile`のtarget.bbox）から決まる。
    """

    def __init__(self, repository: RoadGraphRepository):
        self._repository = repository

    async def get_search_slice(self, bbox: BoundingBox) -> tuple[RoadSlice, TileSet] | None:
        """探索範囲の区間を返す。

        切り出すのはbboxそのもの。あわせて返すbboxを覆うz12タイルの集合は、近い範囲をまとめて
        指す鍵として使う（学習した迂回率の鍵）。
        """
        if not await self._repository.is_covered(bbox):
            logger.warning(
                "取込範囲外のbbox (%.2f,%.2f,%.2f,%.2f)",
                bbox.min_latitude, bbox.min_longitude, bbox.max_latitude, bbox.max_longitude)
            return None

        started = start_timer()
        tiles = tiles_covering_bbox(bbox, DETOUR_RATIO_SHARING_ZOOM)
        # 全区間を走査するので、読み込みと一緒にイベントループの外で切り出す。
        road = await asyncio.to_thread(_slice_current, bbox)
        limit = _max_search_edges()
        if limit is not None and road.edge_count > limit:
            logger.warning(
                "探索範囲の区間が上限を超えたため使わない bbox=(%.2f,%.2f,%.2f,%.2f) tiles=%d edges=%d limit=%d",
                bbox.min_latitude, bbox.min_longitude, bbox.max_latitude, bbox.max_longitude,
                len(tiles), road.edge_count, limit)
            raise SearchAreaTooLargeError(road.edge_count, limit)
        logger.info(
            "get_search_slice tiles=%d edges=%d nodes=%d slice_ms=%d",
            len(tiles), road.edge_count, road.node_count, elapsed_ms(started),
        )
        tile_set = frozenset((DETOUR_RATIO_SHARING_ZOOM, x, y) for x, y in tiles)
        return road, tile_set

    async def get_edges_with_geometry(self, edges: list[LeanEdge]) -> dict[str, LeanEdge]:
        """探索用グラフは形を持たない。確定した経路の区間へ実体を後付けする。"""
        return await self._repository.get_edges_with_geometry(edges)

    async def get_route_side_points(self, edges: list[LeanEdge]) -> dict[tuple[int, int], list[RoutePointHit]]:
        """確定した経路の区間ごとの、近くの点（停止要因・補給・立ち寄り先・事故）。"""
        return await self._repository.get_route_side_points(edges)
