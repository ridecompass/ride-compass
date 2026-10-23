import asyncio
import logging

from app.domain.stopwatch import elapsed_ms, start_timer
from app.config import settings
from app.domain.errors import SearchAreaTooLargeError
from app.domain.graph import LeanEdge, parse_edge_key
from app.domain.region import BoundingBox, tiles_covering_bbox
from app.domain.attributes import CategoricalColumn
from app.domain.road_classes import RoadClassDefinitions, current_road_classes
from app.domain.road_network import RoadNetwork, RoadSlice, edge_row_of, road_class_columns, slice_network
from app.domain.route_search import DETOUR_RATIO_SHARING_ZOOM
from app.domain.route import RoutePoint, along_route_km
from app.domain.route_points import DirectedSegment, points_along_route
from app.infrastructure import container_memory, road_network_store
from app.infrastructure.detour_ratio_cache import TileSet
from app.infrastructure.road_graph_repository import RoadGraphRepository

logger = logging.getLogger("ridecompass.graph")

#: 生成以外（地図タイルの配信・プロセスの常駐分）のために取り置くメモリ。
_RESERVED_BYTES = 2 * 1024**3
#: 1件の生成が、切り出した有向の区間1本あたりに使うメモリ（探索用グラフ・コスト配列・ターン構造・候補の評価の合計）。
_BYTES_PER_EDGE = 1100


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
_classes: tuple[RoadNetwork, RoadClassDefinitions, tuple[dict[str, CategoricalColumn], dict[str, CategoricalColumn]]] | None = None


def _network_classes(network: RoadNetwork) -> tuple[dict[str, CategoricalColumn], dict[str, CategoricalColumn]]:
    """取込範囲全体の区分の列と層ごとの値。道路網と区分の全体の組ごとに1回だけ作り、組が替わったら丸ごと入れ替える。

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


def _lengths_km_current(segments: list[DirectedSegment]) -> list[float] | None:
    """区間それぞれの長さ（km。生成が積むのと同じ道路網の値）。今の道路網に無い区間があればNone。"""
    network = road_network_store.current()
    rows = [edge_row_of(network, *segment) for segment in segments]
    if any(row is None for row in rows):
        return None
    return [float(network.distance_m[row]) / 1000 for row in rows]


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

    async def get_route_side_points(self, edge_ids: list[str], start_km: float) -> list[RoutePoint] | None:
        """経路の一続きの区間（`domain/graph.py: edge_key`の並び）の近くの点（停止要因・補給・立ち寄り先・事故）を、
        通る道のりの順に。

        道のりは`start_km`（一続きの始まりの道のり）から区間の長さを積んだもので、候補の区間の道のりと同じ物差し。
        鍵の形が違う区間か、今の道路網に無い区間があればNone。
        """
        parsed = [parse_edge_key(key) for key in edge_ids]
        segments = [segment for segment in parsed if segment is not None]
        if len(segments) < len(parsed):
            return None
        lengths_km = await asyncio.to_thread(_lengths_km_current, segments)
        if lengths_km is None:
            return None
        hits = await self._repository.get_route_side_points((way, segment) for way, segment, _ in segments)
        return points_along_route(segments, along_route_km(lengths_km, start_km), hits)
