"""`domain/region.py`——緯度経度の矩形と、XYZタイル（Web Mercator）との行き来。

入口は`BoundingBox`・`bbox_covering_points`・`parse_bbox`・`tile_bounds_lonlat`・`tile_bounds_3857`・
`tiles_covering_bbox`・`way_unit_tile`・`edge_unit_tile`。期待値はWeb Mercatorの公開の定義（WGS84の長半径6378137m・緯度の限界±85.0511度）と、
地球を半径6371kmの球とみなした距離から書き、実装の定数を掛け戻さない。

ここで見ないもの:
- `tile_position_sql`の式が地点を正しいタイルの位置へ写すこと → SQLを実行する標高の派生
  （`test_derive_elevation.py`）。ここでは式の文字列しか手に入らない
- 矩形の緯度経度の範囲（±90・±180）は`Field`の宣言が持つ
"""

import math
from typing import NamedTuple

import pytest
from hypothesis import given
from hypothesis import strategies as st
from pydantic import ValidationError

from app.domain.region import (
    EDGE_UNIT_MIN_ZOOM,
    ROAD_TILE_MAX_ZOOM,
    ROAD_TILE_MIN_ZOOM,
    BoundingBox,
    bbox_covering_points,
    edge_unit_tile,
    parse_bbox,
    tile_bounds_3857,
    tile_bounds_lonlat,
    tiles_covering_bbox,
    way_unit_tile,
)

WGS84_SEMI_MAJOR_AXIS_M = 6378137.0
KM_PER_DEGREE_ON_A_6371KM_SPHERE = 2 * math.pi * 6371.0 / 360


class Point(NamedTuple):
    latitude: float
    longitude: float


def box(min_lat: float, min_lon: float, max_lat: float, max_lon: float) -> BoundingBox:
    return BoundingBox(min_latitude=min_lat, min_longitude=min_lon, max_latitude=max_lat, max_longitude=max_lon)


# --- BoundingBox ---


@pytest.mark.parametrize(
    ("corners", "message"),
    [
        ((35.0, 139.0, 35.0, 139.1), "緯度はmin < maxが必要です"),
        ((35.0, 139.0, 35.1, 139.0), "経度はmin < maxが必要です"),
    ],
)
def test_a_box_with_empty_sides_is_rejected(corners, message):
    with pytest.raises(ValidationError, match=message):
        box(*corners)


# --- bbox_covering_points ---


def test_the_margin_extends_every_side_by_about_that_many_kilometers_converting_longitude_at_the_mean_latitude():
    covering = bbox_covering_points([Point(30.0, 139.0), Point(40.0, 140.0)], margin_km=10.0)

    km_per_degree_longitude = KM_PER_DEGREE_ON_A_6371KM_SPHERE * math.cos(math.radians(35.0))
    assert (30.0 - covering.min_latitude) * KM_PER_DEGREE_ON_A_6371KM_SPHERE == pytest.approx(10.0, rel=0.01)
    assert (covering.max_latitude - 40.0) * KM_PER_DEGREE_ON_A_6371KM_SPHERE == pytest.approx(10.0, rel=0.01)
    assert (139.0 - covering.min_longitude) * km_per_degree_longitude == pytest.approx(10.0, rel=0.01)
    assert (covering.max_longitude - 140.0) * km_per_degree_longitude == pytest.approx(10.0, rel=0.01)


# --- parse_bbox ---


def test_parse_bbox_reads_min_lat_min_lon_max_lat_max_lon_in_that_order():
    assert parse_bbox("35.0, 139.0,35.5,139.5") == box(35.0, 139.0, 35.5, 139.5)


def test_parse_bbox_needs_exactly_four_values():
    with pytest.raises(ValueError, match="4値が必要です"):
        parse_bbox("35.0,139.0,35.5")


# --- tile_bounds_lonlat・tile_bounds_3857 ---


def mercator_m(longitude: float, latitude: float) -> tuple[float, float]:
    """EPSG:3857の順変換（球面メルカトル）。"""
    return (
        WGS84_SEMI_MAJOR_AXIS_M * math.radians(longitude),
        WGS84_SEMI_MAJOR_AXIS_M * math.log(math.tan(math.pi / 4 + math.radians(latitude) / 2)),
    )


tiles = st.integers(min_value=0, max_value=18).flatmap(
    lambda z: st.tuples(st.just(z), st.integers(0, 2**z - 1), st.integers(0, 2**z - 1))
)


@given(tile=tiles)
def test_the_lonlat_and_meter_bounds_of_a_tile_are_the_same_area(tile):
    lonlat = tile_bounds_lonlat(*tile)
    west, south, east, north = tile_bounds_3857(*tile)

    assert mercator_m(lonlat.min_longitude, lonlat.min_latitude) == pytest.approx((west, south), abs=1e-3)
    assert mercator_m(lonlat.max_longitude, lonlat.max_latitude) == pytest.approx((east, north), abs=1e-3)


# --- tiles_covering_bbox ---


def test_a_box_reaching_beyond_the_mercator_limits_stops_at_the_edge_of_the_world():
    assert sorted(tiles_covering_bbox(box(-90.0, -180.0, 90.0, 180.0), 1)) == [(0, 0), (0, 1), (1, 0), (1, 1)]


boxes_in_japan = st.tuples(
    st.floats(min_value=20.0, max_value=46.0),
    st.floats(min_value=0.001, max_value=1.0),
    st.floats(min_value=122.0, max_value=154.0),
    st.floats(min_value=0.001, max_value=1.0),
).map(lambda t: box(t[0], t[2], t[0] + t[1], t[2] + t[3]))


@given(bbox=boxes_in_japan, z=st.integers(min_value=8, max_value=15))
def test_the_tiles_are_exactly_the_block_of_tiles_the_box_touches(bbox, z):
    covering = tiles_covering_bbox(bbox, z)

    xs = sorted({x for x, _ in covering})
    ys = sorted({y for _, y in covering})
    assert len(covering) == len(xs) * len(ys)
    assert xs == list(range(xs[0], xs[-1] + 1)) and ys == list(range(ys[0], ys[-1] + 1))
    # 四隅はどれも、覆うタイルのどれかの中（境目を含む）にある。
    for latitude in (bbox.min_latitude, bbox.max_latitude):
        for longitude in (bbox.min_longitude, bbox.max_longitude):
            assert any(_contains(tile_bounds_lonlat(z, x, y), latitude, longitude) for x, y in covering)
    # 四方の端の列・行は、どれも矩形に触れている（余分な列・行が無い）。境目の上の点は東・南のタイルに入る。
    north_west, south_east = tile_bounds_lonlat(z, xs[0], ys[0]), tile_bounds_lonlat(z, xs[-1], ys[-1])
    assert north_west.max_longitude > bbox.min_longitude and south_east.min_longitude <= bbox.max_longitude
    assert north_west.min_latitude < bbox.max_latitude and south_east.max_latitude >= bbox.min_latitude


def _contains(bounds: BoundingBox, latitude: float, longitude: float) -> bool:
    return (
        bounds.min_latitude <= latitude <= bounds.max_latitude
        and bounds.min_longitude <= longitude <= bounds.max_longitude
    )


# --- 道1本・区間で焼くタイル ---

road_tiles = st.integers(min_value=ROAD_TILE_MIN_ZOOM, max_value=ROAD_TILE_MAX_ZOOM).flatmap(
    lambda z: st.tuples(st.just(z), st.integers(0, 2**z - 1), st.integers(0, 2**z - 1))
)


@given(tile=road_tiles)
def test_the_way_unit_tile_is_the_tile_itself_or_the_closest_way_unit_tile_holding_it(tile):
    """道を押したタイルの道1本の値は、そのタイルを覆う道1本のタイルから取る。覆わないタイルを選ぶと、押した道がそのタイルに
    無く、道1本の値が出ない。"""
    z, x, y = tile
    unit = way_unit_tile(z, x, y)

    if z < EDGE_UNIT_MIN_ZOOM:
        assert unit == tile
    else:
        assert unit[0] == EDGE_UNIT_MIN_ZOOM - 1
        outer, inner = tile_bounds_lonlat(*unit), tile_bounds_lonlat(z, x, y)
        assert _contains(outer, inner.min_latitude, inner.min_longitude)
        assert _contains(outer, inner.max_latitude, inner.max_longitude)


@given(latitude=st.floats(min_value=20.0, max_value=46.0), longitude=st.floats(min_value=122.0, max_value=154.0))
def test_the_edge_unit_tile_of_a_point_holds_the_point(latitude, longitude):
    """区間の値は、区間の上の点を含む区間のタイルから取る。点を含まないタイルを選ぶと、区間がそのタイルに無い。"""
    z, x, y = edge_unit_tile(longitude, latitude)

    assert z == EDGE_UNIT_MIN_ZOOM
    assert _contains(tile_bounds_lonlat(z, x, y), latitude, longitude)
