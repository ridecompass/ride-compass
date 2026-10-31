"""`app/domain/node_spatial_index.py`——置いた点に一番近いノード。

ここで見ないもの:
- 出て戻れるノードの集まり → `test_routing.py`
"""
import numpy as np
import pytest

from app.domain import node_spatial_index
from app.domain.geo import haversine_distance_km_array
from app.domain.route import Coordinates
from tests.search_graph_world import (
    make_graph,
)


def coords(latitude, longitude):
    return Coordinates(latitude=latitude, longitude=longitude)


# --- build_node_spatial_index / find_nearest_node_indexed ---

SNAP_GRAPH = make_graph(
    {
        "center": (35.0099, 139.0099),
        "north": (35.0101, 139.0050),
        "far": (35.0400, 139.0000),
    },
    {},
)


#: 索引の範囲より広い上限。これを渡す呼び出しでは、寄せるかを索引の範囲だけが決める。
WIDER_THAN_THE_AREA_KM = 1000.0


def node_index_of(net):
    return node_spatial_index.build_node_spatial_index(net.latitude, net.longitude, None)


def nearest(net, index, point, allowed_names=None, *, max_distance_km):
    """最寄りノードの名前（無ければNone）。`allowed_names`は候補にしてよいノード名の集合。"""
    allowed = None if allowed_names is None else np.array([node_id in allowed_names for node_id in net.node_ids])
    found = node_spatial_index.find_nearest_node_indexed(index, point, allowed, max_distance_km=max_distance_km)
    return None if found is None else net.node_ids[found]


def test_nearest_node_is_none_when_the_index_has_no_nodes():
    index = node_index_of(make_graph({}, {}))
    assert node_spatial_index.find_nearest_node_indexed(index, coords(35.0, 139.0), max_distance_km=WIDER_THAN_THE_AREA_KM) is None


@pytest.mark.parametrize(
    ("point", "expected"),
    [
        (coords(35.0650, 139.0050), None),   # 緯度が索引の上端より2セル外
        (coords(34.9750, 139.0050), None),   # 緯度が下端より2セル外
        (coords(35.0050, 139.0350), None),   # 経度が右端より2セル外
        (coords(35.0050, 138.9750), None),   # 経度が左端より2セル外
        (coords(35.0550, 139.0000), "far"),  # 縁を1セルだけ外した点（地図の端をクリックした場合）は、すぐ隣の道へ寄せる
    ],
)
def test_nearest_node_is_none_far_outside_the_indexed_area(point, expected):
    """索引が覆う範囲の外を指した点には寄せない。

    ここを通すと、何十kmも離れた道へ黙って寄せた結果が「利用者が指した地点」として扱われ、
    指した覚えのない場所を通るルートになる。
    """
    index = node_index_of(SNAP_GRAPH)
    assert nearest(SNAP_GRAPH, index, point, max_distance_km=WIDER_THAN_THE_AREA_KM) == expected


def test_nearest_node_is_none_when_no_node_is_allowed():
    """1件も真にならないときも索引の範囲を出た時点で止まる（走査が終わる）。"""
    index = node_index_of(SNAP_GRAPH)
    assert nearest(SNAP_GRAPH, index, coords(35.0050, 139.0050), set(), max_distance_km=WIDER_THAN_THE_AREA_KM) is None


def test_nearest_node_respects_max_distance_km():
    """「近くに無いなら寄せない」を距離で表す呼び出し。"""
    index = node_index_of(SNAP_GRAPH)
    point = coords(35.0050, 139.0050)
    assert node_spatial_index.find_nearest_node_indexed(index, point, max_distance_km=0.1) is None
    assert nearest(SNAP_GRAPH, index, point, max_distance_km=5.0) == "north"


@pytest.mark.parametrize(
    "span_deg",
    [
        0.3,  # セルの番号が16ビットに収まる（都心の周回の探索範囲と同じくらいの広さ）
        3.0,  # 収まらない（並べ替えが桁を2回に分ける）
    ],
)
def test_nearest_node_is_the_closest_candidate_by_great_circle_distance(span_deg):
    """散らしたノードのどこを指しても、候補（と`allowed`）のうち球面距離で一番近いノードを返す。"""
    rng = np.random.default_rng(1194)
    node_count = 3000
    latitude = 35.0 + rng.random(node_count) * span_deg
    longitude = 139.0 + rng.random(node_count) * span_deg
    candidates = rng.random(node_count) < 0.9
    allowed = rng.random(node_count) < 0.6
    index = node_spatial_index.build_node_spatial_index(latitude, longitude, candidates)
    for _ in range(40):
        point = coords(float(35.0 + rng.random() * span_deg), float(139.0 + rng.random() * span_deg))
        distances = haversine_distance_km_array(latitude, longitude, point)
        for mask in (candidates, candidates & allowed):
            expected = int(np.flatnonzero(mask)[np.argmin(distances[mask])])
            found = node_spatial_index.find_nearest_node_indexed(
                index, point, None if mask is candidates else allowed, max_distance_km=WIDER_THAN_THE_AREA_KM)
            assert found == expected
