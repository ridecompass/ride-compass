"""`domain/elevation_profile.py`——区間の断面の点の並びと、点の間の勾配・標高の無い長さ・全体の勾配の分布。

入口は`interval_grade`・`unknown_lengths_m`・`grade_distribution`・`ElevationProfiles.take`。

ここで見ないもの:
- 点の間ごとに速さを解いて区間の所要時間にすること（逆向きの行・標高の無い所の埋め方） → `test_cycling_speed.py`
- 断面の点をDBから道路網の配列へ載せること → `test_road_network_store.py`・`test_road_graph_repository_contracts.py`
"""

import numpy as np
import pytest

from app.domain.elevation_profile import grade_distribution, interval_grade, unknown_lengths_m
from tests.profile_fixture import profiles


def test_a_step_reads_the_rise_over_its_length_and_one_without_a_value_or_steeper_than_any_road_has_none():
    """公道としてありえない勾配（標高データの読み違い）は、値の無い間と同じく勾配を持たない。"""
    assert interval_grade(10.0, 13.0, 100.0) == pytest.approx(0.03)
    assert np.isnan(interval_grade(10.0, np.nan, 100.0))
    assert np.isnan(interval_grade(0.0, 50.0, 100.0))
    assert np.isnan(interval_grade(0.0, 1.0, 0.0))


def test_the_length_without_elevation_is_summed_per_road_and_a_road_with_fewer_than_two_points_has_none():
    built = profiles([10.0, None, 12.0], [7.0], [0.0, 50.0, 50.0], [5.0, 5.0], [5.0, 6.0])

    unknown = unknown_lengths_m(built.start, built.points, built.elevation_m, np.array([200.0, 40.0, 200.0, 50.0, 0.0]))

    assert unknown.tolist() == pytest.approx([200.0, 40.0, 100.0, 0.0, 0.0])


def test_the_distribution_is_the_share_of_the_road_run_at_each_slope_both_ways():
    """全体の勾配の分布は、点の間の勾配を1%の階級に分けた道のりの割合。どの向きにも走るので、登りと下りを半分ずつ
    数える。値の無い間は数えない。"""
    built = profiles([0.0, 3.0, 3.0], [0.0, None], [0.0, 1.0])

    distribution = grade_distribution(built.start, built.points, built.elevation_m, np.array([200.0, 50.0, 100.0]))

    assert distribution.grade.tolist() == pytest.approx([-0.03, -0.01, 0.0, 0.01, 0.03])
    assert distribution.share.tolist() == pytest.approx([1 / 6, 1 / 6, 1 / 3, 1 / 6, 1 / 6])


def test_a_slice_keeps_the_points_and_the_direction_of_its_rows():
    built = profiles([1.0, 2.0], [3.0, 4.0, 5.0], forward=[True, False])

    taken = built.take(np.array([1]))

    assert (taken.points.tolist(), taken.forward.tolist()) == ([3], [False])
    assert taken.elevation_m[taken.start[0]:taken.start[0] + 3].tolist() == [3.0, 4.0, 5.0]
