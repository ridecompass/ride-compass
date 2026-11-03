"""`domain/elevation_profile.py`——区間の断面の点の並びから、所要時間と体力を求める点の間を作る。

入口は`ElevationProfiles`（`intervals`・`take`）と`grade_distribution`。

ここで見ないもの:
- 点の間ごとに速さを解いて区間の所要時間にすること → `test_leg_costs.py`
- 断面の点をDBから道路網の配列へ載せること → `test_road_network_store.py`・`test_road_graph_repository_contracts.py`
"""

import numpy as np
import pytest

from app.domain.elevation_profile import ElevationProfiles, GradeDistribution, grade_distribution

UP_AND_DOWN = GradeDistribution(np.array([-0.04, 0.02]), np.array([0.25, 0.75]))


def _profiles(*profiles: list[float | None], distribution=UP_AND_DOWN) -> ElevationProfiles:
    points = np.array([len(p) for p in profiles], dtype=np.int32)
    elevation = np.array([np.nan if v is None else v for p in profiles for v in p], dtype=np.float32)
    return ElevationProfiles(np.cumsum(points, dtype=np.int64) - points, points, elevation, distribution)


def test_each_step_between_neighbouring_points_is_an_interval_of_an_equal_share_of_the_road():
    intervals = _profiles([10.0, 13.0, 12.0], [5.0, 5.0]).intervals(np.array([200.0, 50.0]))

    assert intervals.edge.tolist() == [0, 0, 1]
    assert intervals.length_m.tolist() == [100.0, 100.0, 50.0]
    assert intervals.grade.tolist() == pytest.approx([0.03, -0.01, 0.0])
    assert intervals.missing_edge.tolist() == [False, False]


def test_a_step_or_a_road_without_elevation_runs_the_slopes_of_the_whole_network():
    """標高の無い間と、点が2つ未満の区間は、全体の勾配の分布どおりの坂を同じ長さで走る（平地とみなすと、標高の無い道が
    坂の無い速い道に見える）。"""
    intervals = _profiles([10.0, None, 12.0], [7.0]).intervals(np.array([200.0, 40.0]))

    assert intervals.edge.tolist() == [0, 0, 0, 0, 1, 1]
    assert intervals.length_m.tolist() == pytest.approx([25.0, 75.0, 25.0, 75.0, 10.0, 30.0])
    assert intervals.grade.tolist() == pytest.approx([-0.04, 0.02] * 3)
    assert intervals.missing_edge.tolist() == [True, True]


def test_the_distribution_is_the_share_of_the_road_run_at_each_slope():
    """全体の勾配の分布は、点の間の勾配を1%の階級に分けた道のりの割合。値の無い間は数えない。"""
    profiles = _profiles([0.0, 3.0, 3.0], [0.0, None], [0.0, 1.0])

    distribution = grade_distribution(profiles.start, profiles.points, profiles.elevation_m, np.array([200.0, 50.0, 100.0]))

    assert distribution.grade.tolist() == pytest.approx([0.0, 0.01, 0.03])
    assert distribution.share.tolist() == pytest.approx([1 / 3, 1 / 3, 1 / 3])


def test_a_slice_keeps_the_points_of_its_rows():
    profiles = _profiles([1.0, 2.0], [3.0, 4.0, 5.0])

    taken = profiles.take(np.array([1]))

    assert taken.intervals(np.array([20.0])).grade.tolist() == pytest.approx([0.1, 0.1])
