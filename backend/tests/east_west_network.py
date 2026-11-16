"""東西に並ぶ7つのノードと3本の道の、小さな取込範囲全体の道路網（`RoadNetwork`）。

使う側: `test_road_network.py`（切り出し・材料・標高属性・区間の行）・`test_graph_service.py`（探索範囲の入口）。
材料の名前は架空（`num_a` 等）。
"""

import numpy as np

from app.domain.road_network import RoadNetwork
from tests.road_network_fixture import road_network

# ノード（osm_node_id の昇順）。すべて北緯35度の上に東西に並ぶ。
NODES = [
    (100, 139.000),
    (101, 139.004),
    (102, 139.010),
    (103, 139.020),
    (104, 139.100),
    (105, 139.120),
    (106, 139.140),
]
# 区間（道・区間番号の昇順、同じ区間は順方向が先）: (道, 区間番号, 順方向, 始点の行, 終点の行)。
# 道10は両方向、道20は一方通行、道30は区間が2つの一方通行。
EDGES = [
    (10, 0, True, 0, 1),
    (10, 0, False, 1, 0),
    (20, 0, True, 2, 3),
    (30, 0, True, 4, 5),
    (30, 1, True, 5, 6),
]
DIRECTIONS = {(way, segment, forward) for way, segment, forward, *_ in EDGES}


def network() -> RoadNetwork:
    """西に道10・道20（139.00〜139.02E）、東に道30（139.10〜139.14E）がある道路網。道30の1区間目だけ標高が無く、
    道20は標高があるが公道としてありえない勾配（勾配の値が無い）。"""
    names = [osm_id for osm_id, _ in NODES]
    return road_network(
        {osm_id: (35.0, node_lon) for osm_id, node_lon in NODES},
        {(way, segment): (names[tail], names[head]) for way, segment, forward, tail, head in EDGES if forward},
        oneway=[(way, segment) for way, segment, *_ in EDGES if (way, segment, False) not in DIRECTIONS],
        elevation_of={(10, 0): (10.0, 22.0), (20, 0): (5.0, 505.0), (30, 1): (7.0, 10.0)},
        numeric={"num_a": lambda rows: np.arange(len(rows.way)) * 10.0},
        categorical={"cat_a": lambda rows: ["x", "x", "y", None, "y"]},
        revision=7,
    )
