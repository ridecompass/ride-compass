"""1回のルート生成の間、探索のエンジン（`services/road_graph_engine.py`）と、その仕上げ・候補の組み立てが共有する状態と、
そこから区間・ノードを引く部品。

区間は探索用グラフの番号（`LazyRoadGraph`の区間）、ノードは探索範囲の切り出しの番号で持ち、
区間の文字列の鍵（`edge_key`）は経路の区間の分だけ作る。
"""

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from functools import cached_property
from itertools import accumulate
from typing import NoReturn

import numpy as np

from app.domain.errors import RoutingError
from app.domain.leg_costs import LegCostArrays, LegCostComposer
from app.domain.graph import LeanEdge, edge_key, node_key, parse_edge_key
from app.domain.road_network import RoadSlice, edge_row_of
from app.domain.route import (
    Coordinates,
    DISTANCE_KM_DECIMALS,
)
from app.domain.route_search import (
    MAX_SNAP_CORRECTION_KM,
    heuristic_seconds,
    median_detour_ratio,
    retrace_penalized,
    straight_distances_m,
)
from app.domain.search_graph import LazyRoadGraph, SearchGraphStatics, edge_index_between
from app.domain.node_spatial_index import NodeSpatialIndex, snap_to_accessible_node
from app.domain.turn_structure import TurnExpandedStructure
from app.domain.route_diversity import lengths_by_physical_segment
from app.domain.wind import (
    is_usable_detour_ratio,
)
from app.infrastructure import detour_ratio_cache

logger = logging.getLogger("ridecompass.graph")


@dataclass
class RoadGraphContext:
    """`road_graph_engine.py: RoadGraphEngine.prepare`で構築し、1回の生成の前段・仕上げ・評価（`road_graph_candidates.py: evaluate_routes`）で共有するリクエスト単位の状態。"""

    # 探索範囲の切り出し。ノードの番号・区間の元の行はこれが決める。
    road: RoadSlice
    # 起点のノード番号（`road`の切り出しの番号）。
    origin_node: int
    # 1リクエスト内で繰り返す最寄りNodeの探索（prepareの起点・前段の
    # 各経由地・仕上げの目的地）を都度線形探索せず使い回すための索引
    # （domain/routing.py参照）。
    node_index: NodeSpatialIndex
    # 置いた点を寄せてよいNode（ノード番号順の真偽。`domain/routing.py: largest_strongly_connected_nodes`）。
    # 起点・経由地・目的地をどれもこの中へ寄せるので、置いた点どうしは互いに行き来できる。
    accessible: np.ndarray
    # 探索で通れる区間（区間の番号順の真偽。探索から除く区間でないもの）。
    passable: np.ndarray
    # 探索用グラフ（区間は番号、domain/search_graph.py: LazyRoadGraph参照）。
    lazy_graph: LazyRoadGraph
    # レグごとのコスト配列を合成する部品と、合成済みのレグ配列（前段の区間ごとのレグのあとに、仕上げの往路[最後の
    # 固定点から離れるレグ]と帰り[終点へ向かうレグ]。経由地が無ければ0=往路・1=帰り）。
    # `TracedLoop.leg_of_edge`がこの添字を指す。
    composer: LegCostComposer
    legs: list[LegCostArrays]
    # 周回の復路レグ・目的地ルートの後ろ向き木の基準点に使う起点座標。
    origin: Coordinates
    # A*のヒューリスティック（`straight_distances_m`）を、レグごとの目的地に対して
    # numpyで1回だけベクトル計算するための、ノード番号順の緯度・経度配列。
    node_lat: np.ndarray
    node_lon: np.ndarray
    # 一対全最短経路木用のCSR構造＋Edge実距離配列（domain/search_graph.py: SearchGraphStatics参照）。
    statics: SearchGraphStatics
    # 状態＝有向Edge・辺＝ターンの遷移構造（`statics.csr`から導く。起点にもコストにも
    # 依存しないためリクエスト内で共有する）。
    turn_structure: TurnExpandedStructure
    # 探索範囲を覆うタイル集合。学習した迂回率の鍵に使う。
    tile_set: frozenset[tuple[int, int, int]]
    # A*のヒューリスティック（向かうノード番号→各Nodeからの所要時間の下界[秒]）。向かう先（置いた点・終点）は
    # 1回の生成で固定のため、向かう先ごとに初回だけ計算し、区間の探索・最速の経路・全候補の帰りの探索で共有する。
    heuristics: dict[int, np.ndarray] = field(default_factory=dict)
    # 仕上げが目的地を一番近いNodeでなく出て戻れる最寄りNodeへ寄せた場合の
    # 実際の座標（寄せ直しが無ければNone）。仕上げの戻り値（経路の列）の外で生成器へ伝える。
    destination_correction: Coordinates | None = None



@dataclass(frozen=True)
class FixedLegs:
    """前段（`road_graph_engine.py: RoadGraphEngine.trace_fixed_points`）の結果: 出発地から置いた経由地を置いた順に、区間ごとの最短でつないだ道と、
    仕上げが向かう終点。

    仕上げの戦略はここから続ける。戦略層は終点が出発地か（`closes`）だけを読み、ほかは受け取ったまま仕上げへ渡す。
    """

    # 区間（出発地→1つ目の経由地、…）ごとの、探索用グラフの区間の番号列。添字が`RoadGraphContext.legs`の添字になる。
    segments: list[list[int]]
    # 出発地と置いた経由地のノード番号（置いた順）。最後が最後の固定点。
    nodes: list[int]
    # 前段の道の実距離（m）。
    length_m: float
    # 終点（目的地を寄せたNode。目的地が無ければ出発地のNode）のノード番号と、終点へ向かう帰りのレグの基準点。
    end_node: int
    end_point: Coordinates

    @property
    def last_node(self) -> int:
        return self.nodes[-1]

    @property
    def closes(self) -> bool:
        """終点が出発地か（周回）。目的地を置かない要求と、目的地が出発地と同じNodeへ寄った要求を同じに扱うため、
        置いた点の有無ではなくNodeで決める。周回だけが、経由地の無いときの近道（リング）・方位の名前・逆回り・種類`loop`を持つ。"""
        return self.end_node == self.nodes[0]

    @cached_property
    def edges(self) -> list[int]:
        """前段の道の区間の番号列（区間をつないだもの）。"""
        return [index for segment in self.segments for index in segment]

    @cached_property
    def leg_of_edge(self) -> list[int]:
        return [leg_index for leg_index, segment in enumerate(self.segments) for _ in segment]

    @cached_property
    def waypoint_offsets(self) -> list[int]:
        """置いた経由地を通る所（`TracedLoop.waypoint_offsets`）。経由地は各区間の終わりにある。"""
        return list(accumulate(len(segment) for segment in self.segments))

    def joined(self, outbound: list[int], inbound: list[int]) -> tuple[list[int], list[int]]:
        """前段の道に仕上げの往路と帰りを継いだ区間の番号列と、区間ごとのレグの添字（`TracedLoop.leg_of_edge`）。"""
        leg_index = len(self.segments)
        return (
            [*self.edges, *outbound, *inbound],
            [*self.leg_of_edge, *[leg_index] * len(outbound), *[leg_index + 1] * len(inbound)],
        )

    @property
    def reversible(self) -> bool:
        """逆に回った経路も作って比べてよいか: 出発地へ戻り、逆に回っても置いた経由地を置いた順に通る（経由地が1つ以下）。"""
        return self.closes and len(self.segments) <= 1




def slice_row_of(context: RoadGraphContext, index: int) -> int:
    """区間の番号→切り出した区間の行（材料・スコア行列・表示用配列の行）。"""
    return int(context.lazy_graph.edge_rows[index])


def network_row_of(context: RoadGraphContext, index: int) -> int:
    """区間の番号→道路網全体の区間の行。"""
    return int(context.road.rows[context.lazy_graph.edge_rows[index]])


def node_key_of(road: RoadSlice, node: int) -> str:
    return node_key(int(road.network.node_osm_id[road.nodes[node]]))


def node_label(context: RoadGraphContext, node: int) -> str:
    """常時のログに書くノードの地点。小数2桁の緯度経度で、OSMのidは書かない（logging.md 基本原則4）。"""
    return f"({float(context.node_lat[node]):.2f},{float(context.node_lon[node]):.2f})"


def refuse_at_nodes(context: RoadGraphContext, message: str, **nodes: int) -> NoReturn:
    """経路の形を断る。例外の文は常時のログへ載るため地点は`node_label`で書き、OSMのidはDEBUGにだけ出す。"""
    logger.debug("%s %s", message, " ".join(f"{name}={node_key_of(context.road, n)}" for name, n in nodes.items()))
    raise RoutingError(f"{message} " + " ".join(f"{name}={node_label(context, n)}" for name, n in nodes.items()))


def node_coordinates(context: RoadGraphContext, node: int) -> Coordinates:
    return Coordinates(latitude=float(context.node_lat[node]), longitude=float(context.node_lon[node]))


def snap_point(context: RoadGraphContext, point: Coordinates) -> tuple[int, bool] | None:
    """置いた点を、起点と同じく出て戻れるNodeへ寄せる（`domain/node_spatial_index.py: snap_to_accessible_node`）。"""
    return snap_to_accessible_node(context.node_index, context.accessible, point, MAX_SNAP_CORRECTION_KM)


def _snap_destination(context: RoadGraphContext, destination: Coordinates) -> int | None:
    """目的地を寄せたNode。寄せ直したら、その座標を`context.destination_correction`に残す（利用者のピンを動かす）。"""
    snapped = snap_point(context, destination)
    if snapped is None:
        logger.warning("destination has no accessible node nearby")
        return None
    node, moved = snapped
    if moved:
        context.destination_correction = node_coordinates(context, node)
        logger.warning(
            "corrected destination to nearest accessible node lat=%.2f lon=%.2f",
            context.destination_correction.latitude, context.destination_correction.longitude,
        )
    return node


def resolve_end(context: RoadGraphContext, destination: Coordinates | None) -> tuple[int, Coordinates] | None:
    """仕上げの終点のノード番号と基準点。目的地が無いか、目的地が出発地のNodeへ寄ったら出発地（周回。基準点も置いた出発地に
    揃え、目的地を置かない周回と同じ候補を作る）、ほかは寄せたNodeと寄せたあとの地点。目的地を寄せられなければNone。"""
    if destination is None:
        return context.origin_node, context.origin
    node = _snap_destination(context, destination)
    if node is None:
        return None
    if node == context.origin_node:
        return node, context.origin
    return node, context.destination_correction or destination


def leg_name(leg_index: int) -> str:
    """最後の固定点から離れるレグの名前。経由地が無ければ出発地からの往路。"""
    return "outbound" if leg_index == 0 else f"leg{leg_index}"


def leg_anchor(context: RoadGraphContext, leg_index: int, node: int) -> Coordinates:
    """`node`から離れるレグの基準点。最初のレグは置いた出発地そのもの（寄せたNodeではない）。"""
    return context.origin if leg_index == 0 else node_coordinates(context, node)


def path_km(context: RoadGraphContext, path: list[int]) -> float:
    return round(float(context.statics.edge_length_m[path].sum()) / 1000, DISTANCE_KM_DECIMALS)


def lean_edge(context: RoadGraphContext, index: int) -> LeanEdge:
    """区間の番号から、形を持たない`LeanEdge`（区間の文字列の鍵・両端のノードの鍵付き）を作る。"""
    road, lazy_graph = context.road, context.lazy_graph
    network = road.network
    row = network_row_of(context, index)
    return LeanEdge(
        edge_id=edge_key(int(network.edge_way_id[row]), int(network.edge_segment[row]), bool(network.edge_forward[row])),
        from_node_id=node_key_of(road, int(lazy_graph.edge_from[index])),
        to_node_id=node_key_of(road, int(lazy_graph.edge_to[index])),
        geometry=[],
        distance_m=float(network.distance_m[row]),
        osm_way_id=int(network.edge_way_id[row]),
        segment_index=int(network.edge_segment[row]),
        forward=bool(network.edge_forward[row]),
    )


def lazy_index_of(context: RoadGraphContext, edge_id: str) -> int | None:
    """区間の文字列の鍵→区間の番号。道路網に無い・探索用グラフに載らない（並行区間の採られなかった側）区間はNone。

    道路網にあるのに探索範囲の外の区間は`RuntimeError`——範囲は送られた区間を覆って作るので、外にあるのは範囲を作る側の誤りで、
    利用者への理由（つながっていない等）にすると原因を誤って伝える。"""
    parsed = parse_edge_key(edge_id)
    if parsed is None:
        return None
    network_row = edge_row_of(context.road.network, *parsed)
    if network_row is None:
        return None
    rows = context.road.rows
    position = int(np.searchsorted(rows, network_row))
    if position >= len(rows) or rows[position] != network_row:
        raise RuntimeError("道路網にある区間が探索範囲の外にある")
    index = context.composer.lazy_row(position)
    return index if index >= 0 else None


def origin_states(statics: SearchGraphStatics, node_index: int) -> np.ndarray:
    """`node_index`から出る有向Edge（＝辺基準の木の始点となる状態）。"""
    csr = statics.csr
    return csr.entry_edge_index[csr.indptr[node_index]:csr.indptr[node_index + 1]].astype(np.int64)



def destination_states(structure: TurnExpandedStructure, node_index: int) -> np.ndarray:
    """`node_index`へ入る有向Edge（＝逆向きの辺基準木の始点となる状態）。"""
    return np.flatnonzero(structure.edge_to == node_index)


def measured_detour_ratio(
    context: RoadGraphContext, start_node: int, node_indices: np.ndarray, length_m: np.ndarray,
) -> float:
    """木の根`start_node`から`node_indices`（ノード番号）への道なり距離`length_m`と直線距離の比の中央値（`median_detour_ratio`）。"""
    return median_detour_ratio(
        node_coordinates(context, start_node),
        context.node_lat[node_indices], context.node_lon[node_indices], length_m,
    )


def learn_detour_ratio(context: RoadGraphContext, measured: float) -> float:
    """実測の迂回率が有効なら探索範囲（タイル集合）の学習値として保存し、そのまま返す。
    無効（NaN・非正）なら合成に使っている現在の値（学習値または既定値）を返す。"""
    if not is_usable_detour_ratio(measured):
        return context.composer.detour_ratio
    detour_ratio_cache.set_detour_ratio(context.tile_set, measured)
    return measured


def heuristic_to(context: RoadGraphContext, node: int) -> np.ndarray:
    """`node`へ向かうA*のヒューリスティック（各Nodeからの直線距離を所要時間の下界[秒]へ直したもの）。"""
    heuristic = context.heuristics.get(node)
    if heuristic is None:
        heuristic = context.heuristics[node] = heuristic_seconds(
            straight_distances_m(context.node_lat, context.node_lon, node), context.composer.speed_kmh,
        )
    return heuristic


def reverse_edge_index(context: RoadGraphContext, index: int) -> int | None:
    """区間と同じNode対を逆に向かう区間の番号。一方通行で逆向きが無ければNone。"""
    lazy_graph = context.lazy_graph
    return edge_index_between(context.statics.csr, int(lazy_graph.edge_to[index]), int(lazy_graph.edge_from[index]))


def traveled_columns(context: RoadGraphContext, edges: Sequence[int]) -> np.ndarray:
    """走った区間と、同じNode対の逆向きの区間の番号（重複なし）。走った道を避ける罰を置く列。"""
    traveled: set[int] = set(edges)
    for edge_index in edges:
        reverse_index = reverse_edge_index(context, edge_index)
        if reverse_index is not None:
            traveled.add(reverse_index)
    return np.fromiter(traveled, dtype=np.int64, count=len(traveled))


def avoiding_traveled(costs: np.ndarray, columns: np.ndarray) -> np.ndarray:
    """`costs`（区間が最後の軸）の`columns`の区間へ、走った道を避ける罰を置いた配列。罰が要れば写しを作り、元の
    配列は変えない——同じ配列を区間の表示と、ほかのレグの探索も読む。"""
    if len(columns) == 0:
        return costs
    penalized = costs.copy()
    penalized[..., columns] = retrace_penalized(costs[..., columns])
    return penalized


def physical_segments(context: RoadGraphContext, path: list[int]) -> dict[frozenset[int], float]:
    """区間の番号列（`TracedLoop.data`）を物理区間キー→距離(m)へ（`lengths_by_physical_segment`）。"""
    return lengths_by_physical_segment(
        context.lazy_graph.edge_from, context.lazy_graph.edge_to, context.statics.edge_length_m, path
    )


