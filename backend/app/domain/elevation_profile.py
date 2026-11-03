"""区間の断面の点の並び（標高）から、所要時間と体力を求める単位の「点の間」を作る。

断面の点は、区間を等しい道のりに刻んだ位置の標高（`infrastructure/derived_models.py: EdgeElevationRow.elevation_profile_m`）で、
道路網の配列は全区間の点を順方向に並べてつないだ1本の標高の配列と、向きつきの行ごとの始まりの位置・点の数・逆に読むかで
持つ（区間の両向きの行は同じ点を指し、逆向きの行は並びを逆に読む）。点の間の長さは、区間の長さ÷（点の数−1）。

**標高の無い所は、全体の勾配の分布の平均で埋める**。点が2つ未満の区間と、どちらかの端に値の無い点の間と、公道としてありえない
勾配の間（標高データの読み違い）は、道路網全体の点の間の勾配の分布（距離の重み）どおりの坂を、同じ長さで走る点の間の組に
置き換える——平地とみなすと、標高の無い道が坂の無い速い道に見える。分布は道路網を組むときに1回だけ求め（`grade_distribution`）、
探索の範囲には依らない。
"""

from dataclasses import dataclass

import numpy as np

#: 舗装された公道としてありうる勾配の上限（%）。世界でも最急の公道が35%前後のため、これを超える値は道の起伏ではなく
#: 標高データの読み違い（両端が路面でない地物を指した等）である。区間の要約の列（平均勾配・一番急な所）も、点の間も、
#: これを超える勾配を値として持たない——0次ハードフィルタは値の無い区間を除外しない（`domain/hard_filters.py`）ので、
#: 誤った値で黙って経路から外すより安全側になる。
MAX_PLAUSIBLE_GRADE_PERCENT = 40.0

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
    """区間の行ごとの断面の点（全行が共有する`elevation_m`の`start`から`points`個。`reversed_rows`の行は逆に読む）と、
    標高の無い所を埋める分布。"""

    start: np.ndarray  # int64
    points: np.ndarray  # int32
    reversed_rows: np.ndarray  # bool
    elevation_m: np.ndarray  # float32、値の無い点はNaN
    distribution: GradeDistribution

    def take(self, rows: np.ndarray) -> "ElevationProfiles":
        return ElevationProfiles(np.asarray(self.start[rows]), np.asarray(self.points[rows]),
                                 np.asarray(self.reversed_rows[rows]), self.elevation_m, self.distribution)

    def intervals(self, distance_m: np.ndarray) -> ProfileIntervals:
        """区間（`distance_m`と同じ行の並び）ごとの点の間。標高の無い間は、区間ごとにその長さを足し合わせてから、分布の
        階級ぶんの間に置き換える。"""
        distance_m = np.asarray(distance_m, dtype=np.float64)
        edge, length, grade = _raw_intervals(self.start, self.points, self.reversed_rows, self.elevation_m, distance_m)
        known = ~np.isnan(grade)
        # 点の間が1つも無い区間は、区間全体が標高の無い長さ（欠けた間が1つも無いと`bincount`は整数で返すので、実数の側へ足す）。
        unknown = np.where(np.asarray(self.points) < 2, distance_m, 0.0) + np.bincount(
            edge[~known], weights=length[~known], minlength=len(distance_m))
        missing = np.flatnonzero(unknown > 0)
        share, bins = self.distribution.share, len(self.distribution.share)
        missing_edge = np.zeros(len(distance_m), dtype=bool)
        missing_edge[missing] = True
        return ProfileIntervals(
            edge=np.concatenate([edge[known], np.repeat(missing, bins)]),
            length_m=np.concatenate([length[known], (unknown[missing][:, None] * share[None, :]).ravel()]),
            grade=np.concatenate([grade[known], np.tile(self.distribution.grade, len(missing))]),
            missing_edge=missing_edge,
        )


def _raw_intervals(start: np.ndarray, points: np.ndarray, reversed_rows: np.ndarray, elevation_m: np.ndarray,
                   distance_m: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """区間の行ごとの点の間の`(区間の行, 長さ, 勾配)`。どちらかの端に値の無い間と、ありえない勾配の間の勾配はNaN。"""
    counts = np.maximum(np.asarray(points, dtype=np.int64) - 1, 0)
    edge = np.repeat(np.arange(len(counts)), counts)
    within = np.arange(len(edge)) - np.repeat(np.cumsum(counts) - counts, counts)
    backward = np.repeat(np.asarray(reversed_rows, dtype=bool), counts)
    first = np.repeat(np.asarray(start, dtype=np.int64), counts)
    here = np.where(backward, first + np.repeat(counts, counts) - within, first + within)
    there = np.where(backward, here - 1, here + 1)
    rise = np.asarray(elevation_m[there], dtype=np.float64) - np.asarray(elevation_m[here], dtype=np.float64)
    length = (distance_m / np.maximum(counts, 1))[edge]
    grade = np.divide(rise, length, out=np.full(len(rise), np.nan), where=length > 0)
    grade[np.abs(grade) > MAX_PLAUSIBLE_GRADE_PERCENT / 100] = np.nan
    return edge, length, grade


def grade_distribution(start: np.ndarray, points: np.ndarray, elevation_m: np.ndarray,
                       distance_m: np.ndarray) -> GradeDistribution:
    """点の間の勾配の分布（道のりの重み）。どの向きにも走るので、順方向に読んだ勾配と、その逆向き（符号を返した勾配）を
    半分ずつ数える。値のある間が1つも無ければ、平地だけの分布。"""
    _edge, length, grade = _raw_intervals(start, points, np.zeros(len(points), dtype=bool), elevation_m,
                                          np.asarray(distance_m, dtype=np.float64))
    known = ~np.isnan(grade)
    if not known.any():
        return GradeDistribution(np.zeros(1), np.ones(1))
    centers = np.arange(-_DISTRIBUTION_LIMIT, _DISTRIBUTION_LIMIT + _DISTRIBUTION_STEP / 2, _DISTRIBUTION_STEP)
    both = np.concatenate([grade[known], -grade[known]])
    bins = np.clip(np.rint(both / _DISTRIBUTION_STEP).astype(np.int64) + len(centers) // 2, 0, len(centers) - 1)
    weight = np.bincount(bins, weights=np.tile(length[known], 2), minlength=len(centers))
    used = weight > 0
    return GradeDistribution(centers[used], weight[used] / weight.sum())
