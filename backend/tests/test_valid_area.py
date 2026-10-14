"""`domain/valid_area.py`——値が成り立つ範囲（この中では同じ値が当たると約束する形）。

- 区域の形は、地点を含むときだけ範囲にする
- 最寄りの点（観測所・情報提供地点）で値が決まるものは、その点が最寄りである範囲

ここで見ないもの: 4つの応答（警報・洪水・観測・暑さ指数）が範囲を添えること → それぞれのサービスのテスト、
点の表ごとに図を一度だけ作ること → `test_nearest_point_areas.py`
"""

import pytest
from shapely.geometry import MultiPolygon, Point, box, shape

from app.domain.route import Coordinates
from app.domain.valid_area import NearestPointCells, valid_area_of

INSIDE = Coordinates(latitude=35.5, longitude=139.5)


def _contains(area, point: Coordinates) -> bool:
    return shape(area.model_dump()).contains(Point(point.longitude, point.latitude))


@pytest.mark.parametrize(
    ("geometry", "expected"),
    [
        (box(139.0, 35.0, 140.0, 36.0), True),
        (MultiPolygon([box(139.0, 35.0, 140.0, 36.0), box(141.0, 37.0, 142.0, 38.0)]), True),
        # 地点を含まない形（最寄りの区域へ寄せた・計算の境目で外れた）を範囲にすると、受け取った時点で地点が
        # 範囲の外にあり、同じ値が当たる範囲という約束が成り立たない。
        (box(141.0, 37.0, 142.0, 38.0), False),
    ],
)
def test_an_area_is_valid_only_when_it_contains_the_point(geometry, expected):
    area = valid_area_of(geometry, INSIDE)

    assert (area is not None) == expected
    if area is not None:
        assert area.type == "MultiPolygon"
        assert _contains(area, INSIDE)


# 東西に並ぶ3つの観測所（経度0.2度おき）。
STATIONS = [
    Coordinates(latitude=35.5, longitude=139.3),
    Coordinates(latitude=35.5, longitude=139.5),
    Coordinates(latitude=35.5, longitude=139.7),
]


@pytest.mark.parametrize(
    ("point", "nearest"),
    [
        (Coordinates(latitude=35.52, longitude=139.52), 1),
        (Coordinates(latitude=35.48, longitude=139.38), 0),
        (Coordinates(latitude=35.5, longitude=139.69), 2),
    ],
)
def test_the_area_of_the_nearest_point_holds_the_point_and_only_that_station(point, nearest):
    """最寄りの点の範囲は今の地点と最寄りの点を含み、ほかの点を含まない（ほかの点の近くへ行けば、最寄りが変わる）。"""
    area = NearestPointCells(STATIONS).area(point)

    assert area is not None
    assert _contains(area, point)
    for index, station in enumerate(STATIONS):
        assert _contains(area, station) == (index == nearest)


def test_a_single_point_has_no_boundary():
    """点が1つなら、どこでもそれが最寄りで、外に出ることが無い。"""
    assert NearestPointCells(STATIONS[:1]).area(INSIDE) is None
