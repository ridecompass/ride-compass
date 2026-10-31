"""`domain/route.py`——区間（交差点の間）を`SEGMENT_BIN_DISTANCE_KM`ごとのビンへ束ねる`aggregate_segments_into_bins`と、
区間の値を候補全体へ畳む`merge_*`と、Edge単位の軸の生値を候補全体へ畳む`route_axis_raw_values`。

入口は`aggregate_segments_into_bins`・`merge_route_values`・`merge_material_values`・`merge_material_category_shares`・`route_axis_raw_values`。
応答の型（`RouteCandidate`等）の検証はPydanticが持つ。

密度の軸（区間が`DensityScoreInput`を持つ軸）は、停止密度の軸のように0から始まり上限で頭打ちになる直線で
確かめる——頭打ちの手前だけを通る値では、点数の平均と回数の平均の点数が同じになり、畳み方の違いが出ない。

ここで見ないもの:
- 区間の値をコスト配列から読んで区間を組み立てること → `test_route_generation_behavior.py`
- どの軸が密度の軸か → `test_evaluation.py`
- 候補全体へ畳んだ値を候補へ載せること → `test_route_generator.py`
"""

import pytest
from hypothesis import example, given
from hypothesis import strategies as st

from app.domain import route
from app.domain.axis_definitions import BreakpointLinearShape, MaterialTerm
from app.domain.route import DensityScoreInput, RouteSegmentDetail, SegmentDifficulty

WIDTH = route.SEGMENT_BIN_DISTANCE_KM
#: 停止密度の軸の折れ線（1kmあたりの回数 → 点数。11回/kmで100点、その先は100点）。
STOP_SHAPE = BreakpointLinearShape(
    terms=[MaterialTerm(material="signals_per_km")], breakpoints=[(0.0, 0.0), (11.0, 100.0)],
)


def _segments(distances: list[float], **fields_per_segment) -> list[RouteSegmentDetail]:
    """東へ一直線に連なる区間。`fields_per_segment`は名前 → 区間ごとの値の並び。"""
    segments = []
    cumulative = 0.0
    for i, distance in enumerate(distances):
        segments.append(RouteSegmentDetail(
            start_latitude=35.0, start_longitude=139.0 + i * 0.01,
            end_latitude=35.0, end_longitude=139.0 + (i + 1) * 0.01,
            cumulative_distance_km=cumulative, distance_km=distance, edge_start=i, edge_end=i + 1,
            **({"elevations": [], "road_classes": {}}
               | {name: values[i] for name, values in fields_per_segment.items()}),
        ))
        cumulative += distance
    return segments


def _binned(
    segments: list[RouteSegmentDetail], difficulties: list[SegmentDifficulty] | None = None
) -> list[RouteSegmentDetail]:
    """区間を、区間の難しさ（`difficulties`。省くと値の無い難しさ）から畳んだビンの難しさとともにビンへ束ねる。"""
    if difficulties is None:
        difficulties = [SegmentDifficulty(s.distance_km, None, {}, {}, {}) for s in segments]
    slices = route.route_bin_slices([s.distance_km for s in segments])
    return route.aggregate_segments_into_bins(segments, route.route_bins(difficulties, slices), slices)


def _signal_bins(distances: list[float], signals: list[float], share: float) -> list[RouteSegmentDetail]:
    """信号の数で決まる停止密度の軸（`stops`）と、どの区間も20点の軸（`other`）を持つ区間を束ねたビン。`share`は停止密度の
    軸の重みの割合（`other`が残り）。区間の難しさはエンジンと同じく区間の点数・寄与度・合成から作る。"""
    rounded = [round(distance, route.DISTANCE_KM_DECIMALS) for distance in distances]
    difficulties = []
    for distance, distance_km, count in zip(distances, rounded, signals, strict=True):
        density = count / distance
        score = STOP_SHAPE.score_at(density)
        difficulties.append(SegmentDifficulty(
            distance_km=distance_km,
            difficulty=score * share + 20.0 * (1 - share),
            axis_difficulties={"stops": score, "other": 20.0},
            axis_contributions={"stops": score * share, "other": 20.0 * (1 - share)},
            density_inputs={"stops": DensityScoreInput(
                value=density, distance_km=distance, weight_share=share, shape=STOP_SHAPE)},
        ))
    return _binned(_segments(rounded), difficulties)


def test_a_route_scores_a_density_axis_from_the_mean_count_over_its_bins():
    """候補はビンからもう一度畳む。信号の集まった500m（16回/km、頭打ちの100点）と信号の無い500m（0点）の候補は、点数の
    平均（50点）ではなく8回/kmの点数（72.7点）。"""
    bins = _signal_bins([0.0625] * 16, [1] * 8 + [0] * 8, share=0.6)

    assert route.merge_route_values(bins).axis_difficulties["stops"] == 72.7
    assert route.merge_route_values(bins).axis_contributions["stops"] == pytest.approx(43.6)
    overall = route.merge_route_values(bins).overall_difficulty
    assert overall is not None
    assert overall.average == pytest.approx(51.6)


def test_a_route_scores_a_density_axis_the_same_however_its_road_is_cut():
    """信号1つのある100mの区間を、信号の所で10mと90mに切る（端の信号は両側が0.5回ずつ持つ）。ルートの値は回数だけで
    決まり、道の切り方で変わらない（探索の費用の側は`test_leg_costs.py`）。"""
    whole = _signal_bins([0.1, 0.4], [1, 0], share=0.5)
    cut = _signal_bins([0.01, 0.09, 0.4], [0.5, 0.5, 0], share=0.5)

    assert route.merge_route_values(cut).axis_difficulties == route.merge_route_values(whole).axis_difficulties
    assert route.merge_route_values(cut).axis_contributions == route.merge_route_values(whole).axis_contributions


def test_the_load_of_a_route_is_its_rounded_average_over_every_segment_including_those_without_a_value():
    """欠損の区間を飛ばして積むと、データの無い区間が多いルートほど楽に見える。"""
    overall = route.merge_route_values(_segments([1.0, 1.0, 2.0], difficulty=[10.0, None, 20.0])).overall_difficulty

    assert overall is not None
    # 平均 50/3 は 16.7 に丸め、総量はその 16.7 に全区間の 4km を掛ける（丸める前の平均なら 66.7）。
    assert (overall.average, overall.load) == (16.7, 66.8)


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


def test_difficulties_keep_one_decimal_and_physical_values_keep_four_significant_digits():
    """物理量はスケールが軸ごとに違う。小数の桁で丸めると、桁の小さい値がまるごと潰れる。"""
    segments = _segments(
        [0.1, 0.2],
        axis_difficulties=[{"axis_a": 10.0}, {"axis_a": 20.0}],
        axis_contributions=[{"axis_a": 10.0}, {"axis_a": 20.0}],
        material_values=[{"material_a": 1000.0}, {"material_a": 2000.0}],
    )

    assert route.merge_route_values(segments).axis_difficulties == {"axis_a": 16.7}
    assert route.merge_route_values(segments).axis_contributions == {"axis_a": 16.7}
    assert route.merge_material_values(segments) == {"material_a": 1667.0}


@given(st.lists(
    st.tuples(
        st.floats(min_value=0.0, max_value=1.5).map(lambda distance: round(distance, 2)),
        st.dictionaries(st.sampled_from(["axis_a", "axis_b"]), st.floats(min_value=-50.0, max_value=50.0)),
    ),
    min_size=1, max_size=40,
))
@example([(0.25, {"axis_a": 1.0}), (0.25, {}), (0.5, {"axis_a": 4.0})])
def test_route_raw_values_match_the_mean_over_the_bins_of_the_segments(edges):
    """区間の材料の値（同じ畳み方）を区間 → ビン → 候補と畳んだ値と、桁まで同じになる。

    例は、値を持たない区間がビンの重みにだけ効く形（ビンを経ずに区間の距離で平均すると値が変わる）。
    """
    segments = _segments([distance for distance, _ in edges], material_values=[values for _, values in edges])

    slices = route.route_bin_slices([distance for distance, _ in edges])
    assert route.route_axis_raw_values(edges, slices) == route.merge_material_values(_binned(segments))


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
        road_classes=[
            {"surface": [stretch(distance_km=0.1, value="paved")]},
            {"surface": [stretch(distance_km=0.0, value="gravel")]},
            {"surface": [stretch(distance_km=0.2, value="paved")]},
            {"surface": [stretch(distance_km=0.3, value=None)]},
        ],
    ))

    assert [b.road_classes for b in bins] == [
        {"surface": [stretch(distance_km=0.3, value="paved"), stretch(distance_km=0.3, value=None)]}]


def test_category_shares_are_the_share_of_distance_among_segments_that_have_the_material():
    shares = route.merge_material_category_shares([
        (0.2, {"surface": "gravel"}),
        (0.6, {"surface": "paved", "lit": "yes"}),
        (0.2, {"surface": "gravel"}),
        (0.5, {}),
        (0.0, {"surface": "soil"}),  # 長さの無い区間は数えない
    ])

    assert shares == {"surface": {"paved": 0.6, "gravel": 0.4}, "lit": {"yes": 1.0}}


def test_category_shares_are_listed_from_the_largest_and_ties_by_name():
    shares = route.merge_material_category_shares([
        (0.1, {"surface": "soil"}), (0.3, {"surface": "gravel"}), (0.3, {"surface": "compacted"}),
    ])

    assert list(shares["surface"]) == ["compacted", "gravel", "soil"]
