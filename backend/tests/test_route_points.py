"""`app/domain/route_points.py`——ルートの近くの点を、経路の上で通る距離へ並べる計算。

ここで見ないもの:
- どの点がどの区間の近くにあるか（区間の形の上の位置・道からの距離） → `test_route_points_postgis.py`
- 区間の長さを道路網から引くこと・口の応答へ点が載ること → `test_routes_generate.py`

区間は1本1km（向きは`forward`）で、点の当たりは区間の形の向き（順向き）で測った位置で書く。
"""
import pytest

from app.domain.route import along_route_km
from app.domain.route_points import DirectedSegment, RoutePointHit, points_along_route
from app.domain.traffic import POI_CLUSTER_EPS_M


def _edge(way: int, forward: bool = True) -> DirectedSegment:
    return way, 0, forward


def _hit(key: str, fraction: float, distance_m: float = 0.0, merge_group: str | None = None) -> RoutePointHit:
    return RoutePointHit(layer="supply_poi", point_key=key, merge_group=merge_group,
                         properties={"kind": key}, fraction=fraction, distance_m=distance_m)


def _passed(path: list[DirectedSegment], hits: dict[int, list[RoutePointHit]]) -> list[tuple[float, str]]:
    points = points_along_route(path, along_route_km(1.0 for _ in path),
                                {(way, 0): found for way, found in hits.items()})
    return [(point.distance_km, point.properties["kind"]) for point in points]


@pytest.mark.parametrize("forward, expected_km", [(True, 0.25), (False, 0.75)])
def test_a_point_is_placed_where_the_route_passes_it_in_its_direction(forward, expected_km):
    """逆向きに走る区間では、区間の形の向きの位置を裏返す。裏返さないと、印がグラフの違う所に出る。"""
    assert _passed([_edge(1, forward)], {1: [_hit("p", 0.25)]}) == [(expected_km, "p")]


def test_a_point_near_consecutive_segments_is_passed_once_where_it_is_nearest():
    """続けて走る区間の両方の近くにある点は、1回通るだけなので1つの印にし、いちばん近い所に置く。"""
    path = [_edge(1), _edge(2)]

    assert _passed(path, {1: [_hit("p", 0.9, distance_m=60.0)], 2: [_hit("p", 0.1, distance_m=20.0)]}) == [(1.1, "p")]


@pytest.mark.parametrize("path, expected", [
    # 行き止まりで折り返す: 同じ区間を続けて逆向きに走る
    ([_edge(1), _edge(2), _edge(2, forward=False)], [(1.5, "p"), (2.5, "p")]),
    # 別の道を回って同じ区間へ戻る
    ([_edge(2), _edge(3), _edge(2)], [(0.5, "p"), (2.5, "p")]),
])
def test_a_point_passed_twice_is_listed_at_each_pass(path, expected):
    """同じ点を2回通るなら、通るたびに印を出す（帰りにも同じ補給所に寄れる）。"""
    assert _passed(path, {2: [_hit("p", 0.5)]}) == expected


@pytest.mark.parametrize("second_fraction, second_group, expected", [
    # 同じ行の点が、まとめる距離の内にある → 1つにする
    (0.5 + POI_CLUSTER_EPS_M / 1000 * 0.9, "signal", [(0.5, "a")]),
    # まとめる距離の外 → 別々
    (0.5 + POI_CLUSTER_EPS_M / 1000 * 1.1, "signal", [(0.5, "a"), (0.54, "b")]),
    # 近くても別の行 → 別々
    (0.5 + POI_CLUSTER_EPS_M / 1000 * 0.9, "crossing", [(0.5, "a"), (0.54, "b")]),
])
def test_points_of_the_same_group_close_along_the_route_are_one_mark(second_fraction, second_group, expected):
    """まとめる行を持つ点（停止要因）は、地図と同じく、同じ行の近い点を1つにする。1つの信号交差点が流入路ごとの
    点で描かれていても、グラフに信号の印が何個も並ばない。"""
    hits = [_hit("a", 0.5, merge_group="signal"), _hit("b", second_fraction, merge_group=second_group)]

    assert _passed([_edge(1)], {1: hits}) == expected
