import asyncio
import logging
from collections.abc import Mapping, Sequence

from app.domain.stopwatch import elapsed_ms, start_timer
from app.domain.geo import LatLonPoint
from app.domain.graph import LeanEdge, parse_edge_key
from app.domain.region import BoundingBox, tiles_covering_bbox
from app.domain.attributes import CategoricalColumn
from app.domain.road_classes import RoadClassDefinitions, current_road_classes
from app.domain.road_network import (
    MaterialFills,
    RoadNetwork,
    RoadSlice,
    edge_endpoint_points,
    material_fills,
    road_class_columns,
    slice_network,
)
from app.domain.route_search import DETOUR_RATIO_SHARING_ZOOM
from app.infrastructure import road_network_store
from app.infrastructure.detour_ratio_cache import TileSet
from app.infrastructure.road_graph_repository import RoadGraphRepository

logger = logging.getLogger("ridecompass.graph")

#: 最後に作った区分の列と、作ったときの道路網・区分の全体。どちらかが入れ替わったら作り直す。
_classes: tuple[RoadNetwork, RoadClassDefinitions, tuple[dict[str, CategoricalColumn], dict[str, CategoricalColumn]]] | None = None


def network_classes(network: RoadNetwork) -> tuple[dict[str, CategoricalColumn], dict[str, CategoricalColumn]]:
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


#: 最後に求めた欠けを埋める平均と、求めたときの道路網・区分の列・材料。どれかが入れ替わったら求め直す。
_fills: tuple[RoadNetwork, Mapping[str, CategoricalColumn], tuple[str, ...], MaterialFills] | None = None


def network_fills(network: RoadNetwork, material_ids: tuple[str, ...]) -> MaterialFills:
    """取込範囲全体の欠けを埋める平均（`domain/road_network.py: material_fills`）。区分の材料の割合は全区間を数えるので、
    道路網・区分の列・材料の組ごとに1回だけ求める。"""
    global _fills
    classes = network_classes(network)[0]
    cached = _fills
    if cached is not None and cached[0] is network and cached[1] is classes and cached[2] == material_ids:
        return cached[3]
    fills = material_fills(network, classes, material_ids)
    _fills = (network, classes, material_ids, fills)
    return fills


def _slice_current(bbox: BoundingBox) -> RoadSlice:
    network = road_network_store.current()
    return slice_network(
        network, network_classes(network),
        bbox.min_longitude, bbox.min_latitude, bbox.max_longitude, bbox.max_latitude,
    )


class GraphService:
    """探索範囲の道路網を、取込範囲全体の配列（`infrastructure/road_network_store.py`）から
    切り出す。**読むだけで、作らない。**

    道路網は取込範囲の中にしか無いので、取込範囲の外は区間が0本の切り出しになる。
    """

    def __init__(self, repository: RoadGraphRepository):
        self._repository = repository

    async def get_search_slice(self, bbox: BoundingBox) -> tuple[RoadSlice, TileSet]:
        """探索範囲の区間を返す。

        切り出すのはbboxそのもの。あわせて返すbboxを覆うz12タイルの集合は、近い範囲をまとめて
        指す鍵として使う（学習した迂回率の鍵）。
        """
        started = start_timer()
        tiles = tiles_covering_bbox(bbox, DETOUR_RATIO_SHARING_ZOOM)
        # 全区間を走査するので、読み込みと一緒にイベントループの外で切り出す。
        road = await asyncio.to_thread(_slice_current, bbox)
        logger.info(
            "get_search_slice tiles=%d edges=%d nodes=%d slice_ms=%d",
            len(tiles), road.edge_count, road.node_count, elapsed_ms(started),
        )
        tile_set = frozenset((DETOUR_RATIO_SHARING_ZOOM, x, y) for x, y in tiles)
        return road, tile_set

    def edge_endpoints(self, edge_ids: Sequence[str]) -> list[LatLonPoint]:
        """区間の鍵の列の、両端の地点（取込範囲全体の道路網から引く）。形の合わない鍵と道路網に無い区間は飛ばす。"""
        edges = [parsed for edge_id in edge_ids if (parsed := parse_edge_key(edge_id)) is not None]
        return edge_endpoint_points(road_network_store.current(), edges)

    async def get_edges_with_geometry(self, edges: list[LeanEdge]) -> dict[str, LeanEdge]:
        """探索用グラフは形を持たない。確定した経路の区間へ実体を後付けする。"""
        return await self._repository.get_edges_with_geometry(edges)
