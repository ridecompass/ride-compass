"""探索用グラフ・ターンの遷移・最近傍のノード・探索のテストが共有する、名前を付けた小さな道路網。

**対象の入力は番号の配列だが、テストは名前で書く。** `make_graph`がノードと区間に名前を付けた
小さな道路網を配列へ直し（区間の行は渡した順）、`lazy_of`・`build_all`が探索用グラフの区間の番号と
名前を結ぶ。値は探索用グラフと遷移が読む列（位置・端点・距離・方位）だけを指定する。

使う側: `test_search_graph.py`・`test_turn_structure.py`・`test_node_spatial_index.py`・`test_routing.py`。
"""
import dataclasses
import math
from typing import NamedTuple

import numpy as np

from app.domain import search_graph, turn_structure


class EdgeSpec(NamedTuple):
    from_node_id: str
    to_node_id: str
    distance_m: float


@dataclasses.dataclass
class Net:
    """名前付きの小さな道路網と、それを直した配列（区間の行は渡した順）。"""
    node_ids: list[str]
    node_id_to_index: dict[str, int]
    # 行の順の区間の名前。
    edge_ids: list[str]
    edges: dict[str, EdgeSpec]
    latitude: np.ndarray
    longitude: np.ndarray
    edge_from: np.ndarray
    edge_to: np.ndarray
    distance_m: np.ndarray
    # 始点のそば・終点のそばの方位。方位を持たない区間はNaN。
    start_bearing_deg: np.ndarray
    end_bearing_deg: np.ndarray


def make_graph(nodes, edges):
    """`nodes`は`{node_id: (緯度, 経度)}`、`edges`は`{edge_id: (始点, 終点[, 距離m[, 方位]])}`。

    方位は1つの値（まっすぐな区間）か、`(始点のそばの方位, 終点のそばの方位)`の組（途中で向きが変わる区間）。
    """
    node_ids = list(nodes)
    index = {node_id: i for i, node_id in enumerate(node_ids)}
    specs = {edge_id: _edge(*spec) for edge_id, spec in edges.items()}
    ends = [_bearing_ends(spec[3]) for spec in specs.values()]
    return Net(
        node_ids=node_ids,
        node_id_to_index=index,
        edge_ids=list(edges),
        edges={edge_id: EdgeSpec(*spec[:3]) for edge_id, spec in specs.items()},
        latitude=np.array([lat for lat, _ in nodes.values()], dtype=float),
        longitude=np.array([lon for _, lon in nodes.values()], dtype=float),
        edge_from=np.array([index[spec[0]] for spec in specs.values()], dtype=np.int64),
        edge_to=np.array([index[spec[1]] for spec in specs.values()], dtype=np.int64),
        distance_m=np.array([spec[2] for spec in specs.values()], dtype=float),
        start_bearing_deg=np.array([start for start, _ in ends], dtype=float),
        end_bearing_deg=np.array([end for _, end in ends], dtype=float),
    )


def _edge(from_node_id, to_node_id, distance_m=100.0, bearing_deg=None):
    return (from_node_id, to_node_id, distance_m, bearing_deg)


def _bearing_ends(bearing_deg):
    if bearing_deg is None:
        return (math.nan, math.nan)
    if isinstance(bearing_deg, tuple):
        return bearing_deg
    return (bearing_deg, bearing_deg)


@dataclasses.dataclass
class NamedLazy:
    """探索用グラフと、その区間の番号順の名前。"""

    graph: search_graph.LazyRoadGraph
    edge_ids: list[str]
    node_id_to_index: dict[str, int]
    index_to_node_id: list[str]

    @property
    def node_count(self):
        return self.graph.node_count


def lazy_of(net):
    graph = search_graph.build_lazy_road_graph(net.edge_from, net.edge_to, len(net.node_ids))
    return NamedLazy(
        graph=graph,
        edge_ids=[net.edge_ids[row] for row in graph.edge_rows.tolist()],
        node_id_to_index=net.node_id_to_index,
        index_to_node_id=net.node_ids,
    )


# ターンの費用をすべて0にする仕様（ターン以外の挙動を見るとき用）。
FLAT_SPEC = turn_structure.TurnCostSpec(
    left_seconds=0.0, right_seconds=0.0, uturn_seconds=0.0, straight_max_deg=180.0,
    major_crossing_seconds=0.0, major_turn_seconds=0.0,
)
# ターンの種別が全部違う値になる仕様。
TURN_SPEC = turn_structure.TurnCostSpec(
    left_seconds=5.0, right_seconds=3.0, uturn_seconds=20.0, straight_max_deg=30.0,
    major_crossing_seconds=7.0, major_turn_seconds=11.0,
)


def build_all(graph, spec=FLAT_SPEC, edge_rank=None, node_has_signal=None, node_db_rank=None):
    """lazy graph・静的派生物・ターン展開構造を一度に組む。

    ターンの費用に要る3つの列は`None`を渡せない（渡し忘れが「上位の道の横断に待ちが付かない」
    構造を黙って作るため）。省略したときは、待ちが付かない値——階級0・信号なし——で埋める。
    """
    lazy = lazy_of(graph)
    statics = search_graph.build_search_graph_statics(lazy.graph, graph.distance_m)
    start_bearings, end_bearings = (
        turn_structure.edge_bearings(lazy.graph, bearing_deg, graph.latitude, graph.longitude)
        for bearing_deg in (graph.start_bearing_deg, graph.end_bearing_deg)
    )
    node_count = lazy.node_count
    structure = turn_structure.build_turn_expanded_structure(
        statics.csr, lazy.graph, start_bearings, end_bearings,
        np.zeros(len(lazy.edge_ids), dtype=np.int64) if edge_rank is None else edge_rank,
        spec,
        np.zeros(node_count, dtype=bool) if node_has_signal is None else node_has_signal,
        np.zeros(node_count, dtype=np.int64) if node_db_rank is None else node_db_rank,
    )
    return lazy, statics, structure


def state_index(lazy):
    return {edge_id: i for i, edge_id in enumerate(lazy.edge_ids)}


# 十字路。中心Cへ東向き（方位90）で入る状態`WC`から、直進・左折・右折・Uターンが1つずつ出る。
PLUS_NODES = {
    "C": (35.00, 139.00),
    "N": (35.01, 139.00),
    "S": (34.99, 139.00),
    "E": (35.00, 139.01),
    "W": (35.00, 138.99),
}
PLUS_EDGES = {
    "WC": ("W", "C", 100.0, 90.0),
    "CW": ("C", "W", 100.0, 270.0),
    "CE": ("C", "E", 100.0, 90.0),
    "EC": ("E", "C", 100.0, 270.0),
    "CN": ("C", "N", 100.0, 0.0),
    "NC": ("N", "C", 100.0, 180.0),
    "CS": ("C", "S", 100.0, 180.0),
    "SC": ("S", "C", 100.0, 0.0),
}

# 直線 A-B-C（＋どのEdgeにも繋がらない孤立Node Z）。
LINE_NODES = {"A": (35.0, 139.0), "B": (35.0, 139.01), "C": (35.0, 139.02), "Z": (35.0, 139.03)}
LINE_EDGES = {
    "AB": ("A", "B", 100.0, 90.0),
    "BA": ("B", "A", 100.0, 270.0),
    "BC": ("B", "C", 100.0, 90.0),
    "CB": ("C", "B", 100.0, 270.0),
}

ONE_WAY_NODES = {k: PLUS_NODES[k] for k in ("C", "N", "E", "W")}
# `CN`だけが一方通行の幹線（Cから出るのみ）。Cへ「入る」区間だけを見ると階級が拾えない。
ONE_WAY_EDGES = {k: PLUS_EDGES[k] for k in ("WC", "CW", "CE", "EC", "CN")}
