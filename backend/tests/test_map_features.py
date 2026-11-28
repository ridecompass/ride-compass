"""地図のフィーチャーの選び方と形（`domain/road_features.py`の`map_features_in`・`map_features_near`・`feature_lines`）。路面タイル・
レンズ・押した所の道・派生データベースの書き出しは、どれもここで選んだフィーチャーを読む。

ここで見ないもの:
- フィーチャーの材料と地図の線の層の値 → `test_feature_materials.py`
- 選んだフィーチャーをタイルに焼くこと → `test_road_tile_sql.py`
"""

import pytest
import shapely

from app.domain.material_catalog import HIGHWAY
from app.domain.region import EDGE_UNIT_MIN_ZOOM, ROAD_SURFACE_ALL_WAYS_MIN_ZOOM
from app.domain.road_features import feature_lines, map_features_in, map_features_near
from tests.road_network_fixture import road_network

#: 道1は東へ2区間（北緯35度の上）、道2はその約55m北に東へ1区間で、西へしか走れない一方通行。
_COORDINATES = {1: (35.0, 139.000), 2: (35.0, 139.001), 3: (35.0, 139.002), 4: (35.0005, 139.000), 5: (35.0005, 139.001)}
_SEGMENTS = {(1, 0): (1, 2), (1, 1): (2, 3), (2, 0): (4, 5)}
#: 道1の区間0の約11m北（道2の区間0まで約44m、道1の区間1まで約47m）。
_PRESSED = (139.0005, 35.0001)


def _network():
    return road_network(_COORDINATES, _SEGMENTS, backward=[(2, 0)])


def _lines(network, features) -> dict[str, list[tuple[float, float]]]:
    return {key: [tuple(point) for point in shapely.get_coordinates(line).tolist()]
            for key, line in zip(features.keys, feature_lines(network, features), strict=True)}


@pytest.mark.parametrize(("z", "expected"), [
    (EDGE_UNIT_MIN_ZOOM, {"1-0": [(139.000, 35.0), (139.001, 35.0)], "2-0": [(139.000, 35.0005), (139.001, 35.0005)]}),
    (EDGE_UNIT_MIN_ZOOM - 1, {"1": [(139.000, 35.0), (139.001, 35.0), (139.001, 35.0), (139.002, 35.0)],
                              "2": [(139.000, 35.0005), (139.001, 35.0005)]}),
], ids=["区間で塗るズーム", "道1本で塗るズーム"])
def test_the_features_of_a_range_are_its_segments_or_its_whole_ways_drawn_along_the_way(z, expected):
    """区間で塗るズームは範囲に重なる区間、引いたズームは範囲に重なる区間の道1本（範囲の外の区間も含む。どのタイルから見ても
    道1本の形と値が同じ）。形はどれも道の向きに描く（逆向きにしか走れない一方通行も）。"""
    network = _network()

    features = map_features_in(network, z, 139.0001, 34.9999, 139.0008, 35.0006)

    assert _lines(network, features) == pytest.approx(expected)
    assert list(zip(features.way_ids, features.segment_indexes)) == (
        [(1, 0), (2, 0)] if z >= EDGE_UNIT_MIN_ZOOM else [(1, None), (2, None)])


@pytest.mark.parametrize(("radius_m", "limit", "expected"), [
    (100.0, 3, ["1-0", "2-0", "1-1"]),
    (30.0, 3, ["1-0"]),
    (100.0, 1, ["1-0"]),
], ids=["近い順", "距離の外", "数の上限"])
def test_the_roads_near_the_pressed_place_come_nearest_first(radius_m, limit, expected):
    features = map_features_near(_network(), EDGE_UNIT_MIN_ZOOM, *_PRESSED, radius_m, limit)

    assert list(features.keys) == expected


def test_a_pressed_road_is_the_feature_of_its_zoom_with_its_whole_line():
    """押して開く小窓は、押した道の値を同じ鍵のタイルのフィーチャーから読み、押した道の線の全体を強調する。"""
    network = _network()

    features = map_features_near(network, EDGE_UNIT_MIN_ZOOM - 1, *_PRESSED, 100.0, 1)

    assert _lines(network, features) == pytest.approx(
        {"1": [(139.000, 35.0), (139.001, 35.0), (139.001, 35.0), (139.002, 35.0)]})


def test_a_zoomed_out_map_draws_only_the_main_roads_and_cycleways():
    """引いた地図は、細い道まで描くと持ちに当たらない1枚に数秒かかる。z10は国道・主な県道と自転車道、z11はそれに地域の道を
    足した道だけを描き、全部の道を描くズームからは細い道も描く。"""
    kinds = {1: "primary", 2: "cycleway", 3: "tertiary", 4: "residential"}
    network = road_network({way * 10 + end: (35.0 + way * 0.001, 139.0 + end * 0.001) for way in kinds for end in (0, 1)},
                           {(way, 0): (way * 10, way * 10 + 1) for way in kinds},
                           categorical={HIGHWAY: lambda rows: [kinds[way] for way in rows.way.tolist()]})

    def drawn(z: int) -> set[str]:
        return {kinds[way] for way in map_features_in(network, z, 138.99, 34.99, 139.01, 35.01).way_ids}

    assert [drawn(z) for z in (10, 11, ROAD_SURFACE_ALL_WAYS_MIN_ZOOM)] == [
        {"primary", "cycleway"},
        {"primary", "cycleway", "tertiary"},
        {"primary", "cycleway", "tertiary", "residential"},
    ]
