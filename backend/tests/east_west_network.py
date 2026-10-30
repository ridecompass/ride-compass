"""東西に並ぶ7つのノードと3本の道の、小さな取込範囲全体の道路網（`RoadNetwork`）。

使う側: `test_road_network.py`（切り出し・材料・標高属性・区間の行）・`test_graph_service.py`（探索範囲の入口）。
材料の名前は架空（`num_a` 等）。平均勾配だけは区間の材料の列から読むため、その材料の名前を対象の名前空間から読む。
"""

import numpy as np

from app.domain import road_network
from app.domain.road_network import RoadNetwork

NAN = float("nan")
GRADE = road_network.GRADIENT_PERCENT

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


def network() -> RoadNetwork:
    """西に道10・道20（139.00〜139.02E）、東に道30（139.10〜139.14E）がある道路網。"""
    lat = np.full(len(NODES), 35.0)
    lon = np.array([node_lon for _, node_lon in NODES])
    edge_from = np.array([tail for *_, tail, _ in EDGES], dtype=np.int32)
    edge_to = np.array([head for *_, head in EDGES], dtype=np.int32)
    n = len(EDGES)
    row = np.arange(n, dtype=np.float64)
    return RoadNetwork(
        revision=7,
        node_osm_id=np.array([osm_id for osm_id, _ in NODES], dtype=np.int64),
        node_lat=lat,
        node_lon=lon,
        node_has_signals=np.zeros(len(NODES), dtype=bool),
        node_max_rank=np.zeros(len(NODES), dtype=np.int64),
        # 区間の端として現れる回数。道30の2区間が接するノード105だけが2本。
        node_branch_count=np.array([1, 1, 1, 1, 1, 2, 1], dtype=np.int16),
        edge_way_id=np.array([way for way, *_ in EDGES], dtype=np.int64),
        edge_segment=np.array([segment for _, segment, *_ in EDGES], dtype=np.int32),
        edge_forward=np.array([forward for _, _, forward, *_ in EDGES], dtype=bool),
        edge_from=edge_from,
        edge_to=edge_to,
        edge_highway=np.zeros(n, dtype=np.int16),
        highway_vocab=("residential",),
        edge_min_lon=np.minimum(lon[edge_from], lon[edge_to]),
        edge_min_lat=np.minimum(lat[edge_from], lat[edge_to]),
        edge_max_lon=np.maximum(lon[edge_from], lon[edge_to]),
        edge_max_lat=np.maximum(lat[edge_from], lat[edge_to]),
        edge_start_bearing_deg=np.array([80.0, 260.0, 100.0, 90.0, NAN]),
        edge_end_bearing_deg=np.array([100.0, 280.0, 80.0, 90.0, NAN]),
        numeric_ids=("num_a", GRADE),
        numeric_values=np.column_stack([row * 10, [3.0, -3.0, NAN, 1.5, 2.5]]),
        categorical_ids=("cat_a",),
        categorical_codes=np.array([[1], [1], [2], [0], [2]], dtype=np.int16),
        categorical_vocab=((None, "x", "y"),),
        distance_m=row * 100 + 100,
        bearing_deg=np.array([90.0, 270.0, 90.0, 90.0, NAN]),
        mid_lat=lat[edge_from],
        mid_lon=(lon[edge_from] + lon[edge_to]) / 2,
        start_elevation_m=np.array([10.0, 22.0, 5.0, NAN, 7.0]),
        end_elevation_m=np.array([22.0, 10.0, 5.0, NAN, 10.0]),
        elevation_gain_m=np.array([12.0, 0.0, 0.0, NAN, 3.0]),
        elevation_loss_m=np.array([0.0, 12.0, 0.0, NAN, 0.0]),
    )
