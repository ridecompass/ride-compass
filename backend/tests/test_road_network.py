"""`domain/road_network.py`——取込範囲全体の道路網を番号で引く配列と、その切り出し。

入口は次のとおり。
- `RoadNetwork`: 組み立てた時点で行数・列数の食い違いを断る
- `slice_network`: 範囲に掛かる区間と、その両端のノードを取り出す
- `rows_in_tile`: 地図のタイルに掛かる区間の行
- `road_class_columns`・`material_arrays_of`: 区分の列と、切り出した区間の材料
- `material_fills`: 欠けた材料を埋める、取込範囲全体の分布
- `elevation_attribute`: 1区間の標高属性
- `edge_row_of`: `(道, 区間番号, 向き)`から区間の行

ここで見ないもの:
- 道路網をDBから組み立てて置いておくこと → `test_road_network_store.py`
- 材料の列の型（`EdgeMaterialArrays`・`CategoricalColumn`・`ElevationAttribute`）の振る舞い → `test_attributes.py`
- 切り出した範囲で経路を探すこと → `test_route_generation_behavior.py`

道路網は`tests/east_west_network.py: network`。
"""

from dataclasses import replace

import numpy as np
import pytest
from hypothesis import example, given
from hypothesis import strategies as st

from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.region import ROAD_TILE_MAX_ZOOM, ROAD_TILE_MIN_ZOOM, tile_bounds_lonlat, tile_position
from app.domain.road_classes import class_material_id
from app.domain.road_network import (
    edge_row_of,
    elevation_attribute,
    material_arrays_of,
    material_fills,
    road_class_columns,
    rows_in_tile,
    slice_network,
)
from tests.east_west_network import EDGES, NODES, network
from tests.road_class_fixture import classification, fact_is, road_classes

@pytest.mark.parametrize(
    "broken",
    [
        {"node_lat": np.zeros(len(NODES) - 1)},  # ノードの列が1行足りない
        {"distance_m": np.zeros(len(EDGES) + 1)},  # 区間の列が1行多い
        {"numeric_ids": ("num_a",)},  # 材料の行列の列数と名前の数が合わない
        {"categorical_vocab": ()},  # 分類の列に語彙が無い
    ],
)
def test_arrays_of_mismatched_shape_are_refused_where_they_are_built(broken):
    with pytest.raises(ValueError, match="道路網の配列の形"):
        replace(network(), **broken)


lons = st.floats(min_value=138.99, max_value=139.15, allow_nan=False)
lats = st.floats(min_value=34.98, max_value=35.02, allow_nan=False)


@given(lon_a=lons, lon_b=lons, lat_a=lats, lat_b=lats)
@example(lon_a=139.020, lon_b=139.100, lat_a=34.99, lat_b=35.01)  # 範囲の縁に区間の端がちょうど触れる
def test_a_slice_keeps_the_edges_and_their_ends_of_the_whole_network(lon_a, lon_b, lat_a, lat_b):
    """どの範囲でも、取る区間は各区間の両端を総当たりで範囲と比べた答えに一致し、切り出しの中の番号で引いた
    両端の座標は全体の区間の両端の座標に一致する。"""
    whole = network()
    min_lon, max_lon = sorted((lon_a, lon_b))
    min_lat, max_lat = sorted((lat_a, lat_b))

    road = slice_network(whole, ({}, {}), min_lon, min_lat, max_lon, max_lat)

    expected = [
        index
        for index, (*_, tail, head) in enumerate(EDGES)
        if min(NODES[tail][1], NODES[head][1]) <= max_lon
        and max(NODES[tail][1], NODES[head][1]) >= min_lon
        and min_lat <= 35.0 <= max_lat
    ]
    assert road.rows.tolist() == expected
    assert road.nodes.tolist() == sorted({end for index in expected for end in EDGES[index][3:]})
    for position, global_row in enumerate(road.rows):
        assert road.node_lon[road.edge_from[position]] == whole.node_lon[whole.edge_from[global_row]]
        assert road.node_lon[road.edge_to[position]] == whole.node_lon[whole.edge_to[global_row]]


#: 範囲の中の、地図の道のタイルの境目の経度・緯度（区間の端が境目ちょうどに乗る場面を引かせる）。
_tile_edges = [tile_bounds_lonlat(z, *(int(v) for v in tile_position(lon, lat, z)))
               for z in range(ROAD_TILE_MIN_ZOOM, ROAD_TILE_MAX_ZOOM + 1)
               for lon in np.arange(138.99, 139.15, 0.005) for lat in np.arange(34.98, 35.02, 0.002)]
edge_lons = st.one_of(lons, st.sampled_from(sorted({b.min_longitude for b in _tile_edges})))
edge_lats = st.one_of(lats, st.sampled_from(sorted({b.min_latitude for b in _tile_edges})))
boxes = st.lists(st.tuples(edge_lons, edge_lons, edge_lats, edge_lats), min_size=len(EDGES), max_size=len(EDGES))
#: ズーム12で(139.05E, 35.0N)を含むタイルの東の境目。
_EAST_EDGE = tile_bounds_lonlat(12, *(int(v) for v in tile_position(139.05, 35.0, 12))).max_longitude


@given(boxes=boxes, lon=lons, lat=lats, z=st.integers(ROAD_TILE_MIN_ZOOM, ROAD_TILE_MAX_ZOOM))
@example(boxes=[(_EAST_EDGE, _EAST_EDGE + 0.01, 35.0, 35.0)] * len(EDGES), lon=139.05, lat=35.0, z=12)  # 東の隣のタイルから境目に触れる
def test_the_rows_in_a_tile_are_the_edges_whose_bounds_touch_it(boxes, lon, lat, z):
    """地図のタイルに掛かる区間は、どのズーム・どの区間の形でも、区間の外接矩形をタイルの範囲と総当たりで比べた答えに
    一致する。取りこぼすと、タイルの端に触れる道がレンズで塗られない。"""
    min_lon, max_lon, min_lat, max_lat = (np.array(v) for v in zip(*(
        (min(a, b), max(a, b), min(c, d), max(c, d)) for a, b, c, d in boxes)))
    whole = replace(network(), edge_min_lon=min_lon, edge_max_lon=max_lon, edge_min_lat=min_lat, edge_max_lat=max_lat)
    x, y = (int(v) for v in tile_position(lon, lat, z))
    tile = tile_bounds_lonlat(z, x, y)

    expected = [row for row in range(len(EDGES))
                if max_lon[row] >= tile.min_longitude and min_lon[row] <= tile.max_longitude
                and max_lat[row] >= tile.min_latitude and min_lat[row] <= tile.max_latitude]
    assert rows_in_tile(whole, z, x, y).tolist() == expected


def test_the_materials_and_road_classes_of_a_slice_follow_its_rows():
    """区分は取込範囲全体の事実から決め、切り出した区間の材料へ同じ行で足す。"""
    whole = network()
    classes = road_class_columns(whole, road_classes({"k": classification({"is_y": [fact_is("cat_a", "y")]})}))
    road = slice_network(whole, classes, 139.015, 34.99, 139.11, 35.01)

    columns = material_arrays_of(road).columns

    assert columns["num_a"].tolist() == [20.0, 30.0]
    assert [columns["cat_a"].value_at(i) for i in range(2)] == ["y", None]
    assert [columns[class_material_id("k")].value_at(i) for i in range(2)] == ["is_y", None]


def test_the_fills_are_the_distance_weighted_distributions_of_the_whole_network():
    """欠けを埋める平均は取込範囲全体の距離で重みを付けたもの（値の無い区間を除く）。"""
    whole = network()
    rules = {"is_x": [fact_is("cat_a", "x")], "is_y": [fact_is("cat_a", "y")]}
    classes = road_class_columns(whole, road_classes({"k": classification(rules)}))

    fills = material_fills(whole, classes[0], [class_material_id("k")])

    # 区間の距離は100〜500m。num_aは0〜40、勾配は3番目の区間だけ値が無い。区分は道30の1区間目だけ値が無い。
    assert fills.numeric_means == pytest.approx({"num_a": 40000 / 1500, GRADIENT_PERCENT: 1550 / 1200})
    assert fills.class_shares == {class_material_id("k"): pytest.approx({"is_x": 300 / 1100, "is_y": 800 / 1100})}


def test_the_elevation_attribute_reads_the_average_grade_from_the_material_and_the_steepest_slopes():
    attribute = elevation_attribute(network(), 0, "10:0:f")

    assert attribute is not None
    assert attribute.model_dump() == {
        "edge_id": "10:0:f",
        "start_elevation_m": 10.0,
        "end_elevation_m": 22.0,
        "elevation_gain_m": 12.0,
        "elevation_loss_m": 0.0,
        "average_grade": 3.0,
        "steepest_gain_percent": 12.0,
        "steepest_loss_percent": 0.0,
    }


def test_grades_missing_in_the_arrays_are_none_in_the_attribute():
    attribute = elevation_attribute(network(), 2, "20:0:f")

    assert attribute is not None
    assert attribute.average_grade is None


@pytest.mark.parametrize(
    ("way", "segment", "forward", "expected"),
    [
        (10, 0, False, 1),
        (30, 1, True, 4),
        (20, 0, False, None),  # 一方通行の逆向き
        (15, 0, True, None),  # 取込範囲に無い道
    ],
)
def test_an_edge_is_found_by_its_way_segment_and_direction(way, segment, forward, expected):
    assert edge_row_of(network(), way, segment, forward) == expected
