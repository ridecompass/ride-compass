"""`domain/route.py`——区間（交差点の間）を`SEGMENT_BIN_DISTANCE_KM`ごとのビンへ束ねる`aggregate_segments_into_bins`と、
区間の続く坂の斜度と平均勾配。

入口は`aggregate_segments_into_bins`・`steepest_signed_percent`。
応答の型（`RouteCandidate`等）の検証はPydanticが持つ。

ここで見ないもの:
- 区間の値をコスト配列から読んで区間を組み立てること、区間とビンと候補の代償の秒の内訳 → `test_route_generation_behavior.py`
"""

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain import route
from app.domain.attributes import ElevationAttribute
from app.domain.route import EdgeSegment, RouteSegmentDetail

WIDTH = route.SEGMENT_BIN_DISTANCE_KM


def _segments(distances: list[float], **fields_per_segment) -> list[EdgeSegment]:
    """東へ一直線に連なる区間。`fields_per_segment`は名前 → 区間ごとの値の並び。"""
    segments = []
    cumulative = 0.0
    for i, distance in enumerate(distances):
        segments.append(EdgeSegment(
            start_latitude=35.0, start_longitude=139.0 + i * 0.01,
            end_latitude=35.0, end_longitude=139.0 + (i + 1) * 0.01,
            cumulative_distance_km=cumulative, distance_km=distance, edge_index=i,
            **({"geometry": None, "start_elevation_m": None, "end_elevation_m": None, "sustained_gradient_percent": None,
                "average_gradient_percent": None, "estimated_arrival_time": "2026-09-22T08:10:00+09:00",
                "axis_seconds": {}, "preferred_seconds": 0.0, "avoided_seconds": 0.0, "road_classes": {}}
               | {name: values[i] for name, values in fields_per_segment.items()}),
        ))
        cumulative += distance
    return segments


def _binned(segments: list[EdgeSegment]) -> list[RouteSegmentDetail]:
    """区間をビンへ束ねる。"""
    return route.aggregate_segments_into_bins(segments, route.route_bin_slices([s.distance_km for s in segments]))


def test_a_bin_closes_as_soon_as_it_reaches_the_width_and_the_rest_stays():
    bins = _binned(_segments([WIDTH / 2, WIDTH / 2, 0.1]))

    assert [b.distance_km for b in bins] == [WIDTH, 0.1]


@given(distances=st.lists(st.floats(min_value=0.001, max_value=1.5), min_size=1, max_size=40))
def test_bins_cover_the_route_without_gaps_or_overlaps(distances):
    segments = _segments(distances)

    bins = _binned(segments)

    # 経路全体の距離が合う（ビンの距離は小数2桁へ丸める）。
    assert sum(b.distance_km for b in bins) == pytest.approx(sum(distances), abs=0.005 * len(bins))
    # 最後のビンのほかは幅に届いている。
    assert all(b.distance_km >= WIDTH for b in bins[:-1])
    # ビンは途切れずに連なり、最初と最後は経路の両端。区間の鍵の範囲も同じに連なる（ビンの近くの点を引く鍵になる）。
    assert (bins[0].start_longitude, bins[-1].end_longitude) == (segments[0].start_longitude, segments[-1].end_longitude)
    assert (bins[0].edge_start, bins[-1].edge_end) == (0, len(segments))
    for before, after in zip(bins, bins[1:]):
        assert (before.end_latitude, before.end_longitude) == (after.start_latitude, after.start_longitude)
        assert before.edge_end == after.edge_start
        assert after.cumulative_distance_km == pytest.approx(
            before.cumulative_distance_km + before.distance_km, abs=0.006)


@pytest.mark.parametrize(
    ("gain", "loss", "expected"),
    [
        pytest.param(8.0, 12.0, 8.0, id="登りがあれば下りより急でも登り"),
        pytest.param(0.0, 4.0, -4.0, id="登りが無ければ下りを負の値で"),
        pytest.param(0.0, 0.0, 0.0, id="平らなら0（-0にしない）"),
        pytest.param(None, 3.0, None, id="値が無ければ値が無い"),
    ],
)
def test_a_road_shows_its_steepest_climb_or_else_its_steepest_descent(gain, loss, expected):
    elevation = ElevationAttribute(edge_id="1:0:f", start_elevation_m=0.0, end_elevation_m=0.0, elevation_gain_m=0.0,
                                   elevation_loss_m=0.0, average_grade=None,
                                   steepest_gain_percent=gain, steepest_loss_percent=loss)

    # 文字の形まで比べる（-0.0は0.0と等しいが、画面に「-0%」と出る）。
    assert repr(route.steepest_signed_percent(elevation)) == repr(expected)


@pytest.mark.parametrize(
    ("sustained", "expected"),
    [
        pytest.param([8.0, -12.0], 8.0, id="登って下っても打ち消し合わない"),
        pytest.param([3.0, 8.0, -12.0], 8.0, id="登りがあれば下りより急でも登りの最大"),
        pytest.param([-2.0, -4.0, 0.0], -4.0, id="登りが無ければ一番急な下り"),
        pytest.param([None, 5.0], 5.0, id="値の無い区間は飛ばす"),
        pytest.param([None], None, id="値が無ければ値が無い"),
    ],
)
def test_a_bin_shows_the_steepest_slope_of_its_roads(sustained, expected):
    """勾配のレンズの色と区間の小窓の「最大」はこの値を出す。平均では登って下る区間が平坦に見える。ならす幅は道の断面の
    刻みが持つ（`test_elevation_values.py`）。"""
    [bin_] = _binned(_segments([0.1] * len(sustained), sustained_gradient_percent=sustained))

    assert bin_.sustained_gradient_percent == expected


@pytest.mark.parametrize(
    ("distances", "grades", "expected"),
    [
        pytest.param([0.1, 0.3], [4.0, -4.0], -2.0, id="道の距離で重みづける"),
        pytest.param([0.1, 0.1], [None, 3.0], 3.0, id="値の無い道は距離にも数えない"),
        pytest.param([0.1, 0.1], [-0.04, 0.0], 0.0, id="0へ丸まる下りは-0にしない"),
        pytest.param([0.1], [None], None, id="値が無ければ値が無い"),
    ],
)
def test_a_bin_shows_the_average_slope_of_its_roads_weighted_by_distance(distances, grades, expected):
    """区間の小窓の「平均」はこの値を出す。"""
    [bin_] = _binned(_segments(distances, average_gradient_percent=grades))

    assert repr(bin_.average_gradient_percent) == repr(expected)


def test_the_shape_of_a_bin_joins_the_segment_shapes_without_repeating_shared_points():
    bins = _binned(_segments(
        [0.1, 0.1, 0.1, 0.3],
        geometry=[
            {"type": "LineString", "coordinates": [[0.0, 0.0], [1.0, 0.0]]},
            None,  # 形の無い区間は飛ばす
            {"type": "LineString", "coordinates": [[1.0, 0.0], [2.0, 0.0]]},
            {"type": "LineString", "coordinates": [[3.0, 0.0], [4.0, 0.0]]},  # 前と離れた区間はそのまま続ける
        ],
    ))

    assert bins[0].geometry == {"type": "LineString", "coordinates": [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0], [4.0, 0.0]]}


def test_a_bin_lists_the_road_classes_of_its_segments_joining_equal_neighbours_and_dropping_empty_ones():
    """道のりのグラフはビンの部分を距離の比で並べて帯を描く。隣どうしの同じ値をつながないと同じ色の帯に境ができ、
    距離0の部分を残すと幅の無い帯が呼び名の行に出る。"""
    stretch = route.RoadClassStretch
    bins = _binned(_segments(
        [0.1, 0.0, 0.2, 0.3],
        road_classes=[{"surface": "paved"}, {"surface": "gravel"}, {"surface": "paved"}, {"surface": None}],
    ))

    assert [b.road_classes for b in bins] == [
        {"surface": [stretch(distance_km=0.3, value="paved"), stretch(distance_km=0.3, value=None)]}]

