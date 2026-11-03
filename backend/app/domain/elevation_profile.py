"""区間の断面の点の並び（標高）から、所要時間と体力を求める単位の「点の間」を作る。

断面の点は、区間を等しい道のりに刻んだ位置の標高（`infrastructure/derived_models.py: EdgeElevationRow.elevation_profile_m`）で、
道路網の配列は向きつきの行ごとに、全行をつないだ1本の標高の配列の中の始まりの位置と点の数で持つ（逆向きの行は並びを
逆にして持つ）。点の間の長さは、区間の長さ÷（点の数−1）。

**標高の無い所は、全体の勾配の分布の平均で埋める**（tasks#1336 原則3）。点が2つ未満の区間と、どちらかの端に値の無い点の間は、
道路網全体の点の間の勾配の分布（距離の重み）どおりの坂を、同じ長さで走る点の間の組に置き換える——平地とみなすと、標高の
無い道が坂の無い速い道に見える。分布は道路網に1回だけ求め（`grade_distribution`）、探索の範囲には依らない。
"""

from dataclasses import dataclass

import numpy as np

#: 勾配の分布の階級の幅と、端の階級の勾配（どちらも勾配の小数。0.01は1%）。端より急な間は端の階級に数える。
_DISTRIBUTION_STEP = 0.01
_DISTRIBUTION_LIMIT = 0.20


@dataclass(frozen=True)
class GradeDistribution:
    """点の間の勾配の分布。`grade`（階級の代表の勾配）ごとの道のりの割合`share`（和は1）。"""

    grade: np.ndarray  # float64
    share: np.ndarray  # float64


@dataclass(frozen=True)
class ProfileIntervals:
    """点の間の並び。`edge`は切り出した区間の何行目の間か、`length_m`は長さ、`grade`は勾配（小数）。`missing_edge`は
    標高の無い間を分布で埋めた区間か（所要時間の欠けの割合が読む）。"""

    edge: np.ndarray  # int64
    length_m: np.ndarray  # float64
    grade: np.ndarray  # float64
    missing_edge: np.ndarray  # bool、区間の行ごと


@dataclass(frozen=True)
class ElevationProfiles:
    """区間の行ごとの断面の点（`start`から`points`個）と、全行をつないだ標高（m、値の無い点はNaN）。"""

    start: np.ndarray  # int64
    points: np.ndarray  # int32
    elevation_m: np.ndarray  # float32
    distribution: GradeDistribution

    def take(self, rows: np.ndarray) -> "ElevationProfiles":
        return ElevationProfiles(np.asarray(self.start[rows]), np.asarray(self.points[rows]), self.elevation_m,
                                 self.distribution)

    def intervals(self, distance_m: np.ndarray) -> ProfileIntervals:
        """区間（`distance_m`と同じ行の並び）ごとの点の間。標高の無い間は分布の階級ぶんの間に置き換える。"""
        distance_m = np.asarray(distance_m, dtype=np.float64)
        edge, length, grade = _raw_intervals(self.start, self.points, self.elevation_m, distance_m)
        known = ~np.isnan(grade)
        # 点の間が1つも無い区間は、区間全体を1つの標高の無い間として埋める。
        whole = np.flatnonzero(np.asarray(self.points) < 2)
        unknown_edge = np.concatenate([edge[~known], whole])
        unknown_length = np.concatenate([length[~known], distance_m[whole]])
        missing_edge = np.zeros(len(distance_m), dtype=bool)
        missing_edge[unknown_edge] = True
        share, bins = self.distribution.share, len(self.distribution.share)
        return ProfileIntervals(
            edge=np.concatenate([edge[known], np.repeat(unknown_edge, bins)]),
            length_m=np.concatenate([length[known], (unknown_length[:, None] * share[None, :]).ravel()]),
            grade=np.concatenate([grade[known], np.tile(self.distribution.grade, len(unknown_edge))]),
            missing_edge=missing_edge,
        )


def _raw_intervals(start: np.ndarray, points: np.ndarray, elevation_m: np.ndarray,
                   distance_m: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """区間の行ごとの点の間の`(区間の行, 長さ, 勾配)`。どちらかの端に値の無い間の勾配はNaN。"""
    counts = np.maximum(np.asarray(points, dtype=np.int64) - 1, 0)
    edge = np.repeat(np.arange(len(counts)), counts)
    within = np.arange(len(edge)) - np.repeat(np.cumsum(counts) - counts, counts)
    index = np.repeat(np.asarray(start, dtype=np.int64), counts) + within
    rise = np.asarray(elevation_m[index + 1], dtype=np.float64) - np.asarray(elevation_m[index], dtype=np.float64)
    length = (distance_m / np.maximum(counts, 1))[edge]
    grade = np.divide(rise, length, out=np.full(len(rise), np.nan), where=length > 0)
    return edge, length, grade


def grade_distribution(start: np.ndarray, points: np.ndarray, elevation_m: np.ndarray,
                       distance_m: np.ndarray) -> GradeDistribution:
    """道路網全体の点の間の勾配の分布（道のりの重み）。値のある間が1つも無ければ、平地だけの分布。"""
    _edge, length, grade = _raw_intervals(start, points, elevation_m, np.asarray(distance_m, dtype=np.float64))
    known = ~np.isnan(grade)
    if not known.any():
        return GradeDistribution(np.zeros(1), np.ones(1))
    centers = np.arange(-_DISTRIBUTION_LIMIT, _DISTRIBUTION_LIMIT + _DISTRIBUTION_STEP / 2, _DISTRIBUTION_STEP)
    bins = np.clip(np.rint(grade[known] / _DISTRIBUTION_STEP).astype(np.int64) + len(centers) // 2, 0, len(centers) - 1)
    weight = np.bincount(bins, weights=length[known], minlength=len(centers))
    used = weight > 0
    return GradeDistribution(centers[used], weight[used] / weight.sum())
