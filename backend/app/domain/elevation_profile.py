"""区間の断面の点の並び（標高）と、所要時間と体力を求める単位の「点の間」の勾配。

断面の点は、区間を等しい道のりに刻んだ位置の標高（`infrastructure/derived_models.py: EdgeElevationRow.elevation_profile_m`）で、
道路網の配列は全区間の点を順方向に並べてつないだ1本の標高の配列と、向きつきの行ごとの始まりの位置・点の数・順方向かで
持つ（区間の両向きの行は同じ点を指し、逆向きの行は勾配の符号を返して読む）。点の間の長さは、区間の長さ÷（点の数−1）。

**点の間は、リクエストに1回だけJITで平らな並びに詰める**（`flatten_spans`）。所要時間は探索の範囲の全区間について
風の時刻ごとに解くため、numpyで点の間（区間の数倍）の配列を組むと、それだけで探索が1秒前後遅くなる。

**このファイルのJITの関数どうしは、このファイルの中で呼び合う**。numbaのキャッシュは呼ぶ側のファイルの更新しか見ないので、
別のファイルのJITの関数から`interval_grade`を呼ぶと、ここを直しても呼ぶ側が直す前の判定のまま動く。

**標高の無い所は、全体の勾配の分布の平均で埋める**。点が2つ未満の区間と、どちらかの端に値の無い点の間と、公道としてありえない
勾配の間（標高データの読み違い）は、区間ごとに長さを足し合わせ（`unknown_lengths_m`）、道路網全体の点の間の勾配の分布
（距離の重み）どおりの坂で走る——平地とみなすと、標高の無い道が坂の無い速い道に見える。分布は道路網を組むときに1回だけ
求め（`grade_distribution`）、探索の範囲には依らない。
"""

from dataclasses import dataclass

import numpy as np
from numba import njit

#: 舗装された公道としてありうる勾配の上限（%）。世界でも最急の公道が35%前後のため、これを超える値は道の起伏ではなく
#: 標高データの読み違い（両端が路面でない地物を指した等）である。区間の要約の列（平均勾配・一番急な所）も、点の間も、
#: これを超える勾配を値として持たない——0次ハードフィルタは値の無い区間を除外しない（`domain/hard_filters.py`）ので、
#: 誤った値で黙って経路から外すより安全側になる。
MAX_PLAUSIBLE_GRADE_PERCENT = 40.0
_MAX_PLAUSIBLE_GRADE = MAX_PLAUSIBLE_GRADE_PERCENT / 100.0

#: 勾配の分布の階級の幅と、端の階級の勾配（どちらも勾配の小数。0.01は1%）。端より急な間は端の階級に数える。
_DISTRIBUTION_STEP = 0.01
_DISTRIBUTION_LIMIT = 0.20


@dataclass(frozen=True)
class GradeDistribution:
    """点の間の勾配の分布。`grade`（階級の代表の勾配）ごとの道のりの割合`share`（和は1）。"""

    grade: np.ndarray  # float64
    share: np.ndarray  # float64


#: 標高の値が無い道路網（全区間が埋められる）の分布。平地だけ。
FLAT = GradeDistribution(np.zeros(1), np.ones(1))


@dataclass(frozen=True)
class ElevationProfiles:
    """区間の行ごとの断面の点（全行が共有する`elevation_m`の`start`から`points`個。`forward`が偽の行は勾配の符号を返して
    読む）と、標高の無い所を埋める分布。"""

    start: np.ndarray  # int64
    points: np.ndarray  # int32
    forward: np.ndarray  # bool
    elevation_m: np.ndarray  # float32、値の無い点はNaN
    distribution: GradeDistribution

    def take(self, rows: np.ndarray) -> "ElevationProfiles":
        return ElevationProfiles(np.asarray(self.start[rows]), np.asarray(self.points[rows]),
                                 np.asarray(self.forward[rows]), self.elevation_m, self.distribution)


@njit(cache=True, nogil=True)
def interval_grade(lower_m: float, upper_m: float, length_m: float) -> float:
    """点の間の、順方向に読んだ勾配（小数）。どちらかの端に値が無いか、公道としてありえない勾配ならNaN（標高の無い間）。
    長さ0の間（長さ0の区間）も勾配を持たない——走る長さが無いので、所要時間にも標高の無い長さにも効かない。"""
    if not length_m > 0:
        return np.nan
    grade = (upper_m - lower_m) / length_m
    if not abs(grade) <= _MAX_PLAUSIBLE_GRADE:  # NaNもここで外れる
        return np.nan
    return grade


@njit(cache=True, nogil=True)
def unknown_lengths_m(start: np.ndarray, points: np.ndarray, elevation_m: np.ndarray, distance_m: np.ndarray) -> np.ndarray:
    """区間の行ごとの、標高の無い長さ（m）の和。点が2つ未満の区間は区間全体。"""
    unknown = np.zeros(len(points))
    for row in range(len(points)):
        count = points[row]
        if count < 2:
            unknown[row] = distance_m[row]
            continue
        step = distance_m[row] / (count - 1)
        first = start[row]
        for i in range(count - 1):
            if np.isnan(interval_grade(elevation_m[first + i], elevation_m[first + i + 1], step)):
                unknown[row] += step
    return unknown


@njit(cache=True, nogil=True)
def flatten_spans(start: np.ndarray, points: np.ndarray, forward: np.ndarray, elevation_m: np.ndarray,
                   distance_m: np.ndarray, unknown_m: np.ndarray, fill_grade: np.ndarray,
                   fill_share: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """区間の行ごとの、値のある点の間と、標高の無い長さを分布の階級ごとに分けた道を、`(行, 長さ, 走る向きの勾配)`の
    平らな並びにする（風に依らないので、リクエストに1回。`domain/cycling_speed.py`が風の時刻ごとに解くループを1本の平らな
    並びにして、CPUがまとめて計算できるようにする）。"""
    total = 0
    for row in range(len(points)):
        total += max(points[row] - 1, 0) + (len(fill_grade) if unknown_m[row] > 0 else 0)
    span_row = np.empty(total, dtype=np.int32)
    span_length = np.empty(total, dtype=np.float32)
    span_grade = np.empty(total, dtype=np.float32)
    found = 0
    for row in range(len(points)):
        count = points[row]
        if count >= 2:
            step = distance_m[row] / (count - 1)
            sign = 1.0 if forward[row] else -1.0
            first = start[row]
            for i in range(count - 1):
                grade = interval_grade(elevation_m[first + i], elevation_m[first + i + 1], step)
                if not np.isnan(grade):
                    span_row[found] = row
                    span_length[found] = step
                    span_grade[found] = sign * grade
                    found += 1
        if unknown_m[row] > 0:
            for k in range(len(fill_grade)):
                span_row[found] = row
                span_length[found] = unknown_m[row] * fill_share[k]
                span_grade[found] = fill_grade[k]
                found += 1
    return span_row[:found], span_length[:found], span_grade[:found]


@njit(cache=True, nogil=True)
def _known_grades(start: np.ndarray, points: np.ndarray, elevation_m: np.ndarray,
                  distance_m: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """値のある点の間の`(順方向に読んだ勾配, 長さ)`。"""
    total = 0
    for row in range(len(points)):
        total += max(points[row] - 1, 0)
    grades = np.empty(total)
    lengths = np.empty(total)
    found = 0
    for row in range(len(points)):
        count = points[row]
        if count < 2:
            continue
        step = distance_m[row] / (count - 1)
        first = start[row]
        for i in range(count - 1):
            grade = interval_grade(elevation_m[first + i], elevation_m[first + i + 1], step)
            if not np.isnan(grade):
                grades[found] = grade
                lengths[found] = step
                found += 1
    return grades[:found], lengths[:found]


def grade_distribution(start: np.ndarray, points: np.ndarray, elevation_m: np.ndarray,
                       distance_m: np.ndarray) -> GradeDistribution:
    """区間ごとに1行で渡した点の間の勾配の分布（道のりの重み）。どの向きにも走るので、順方向に読んだ勾配と、その逆向き
    （符号を返した勾配）を半分ずつ数える。値のある間が1つも無ければ、平地だけの分布。"""
    grades, lengths = _known_grades(np.asarray(start, dtype=np.int64), np.asarray(points, dtype=np.int64),
                                    np.asarray(elevation_m, dtype=np.float32), np.asarray(distance_m, dtype=np.float64))
    if len(grades) == 0:
        return FLAT
    centers = np.arange(-_DISTRIBUTION_LIMIT, _DISTRIBUTION_LIMIT + _DISTRIBUTION_STEP / 2, _DISTRIBUTION_STEP)
    bins = np.clip(np.rint(grades / _DISTRIBUTION_STEP).astype(np.int64) + len(centers) // 2, 0, len(centers) - 1)
    forward = np.bincount(bins, weights=lengths, minlength=len(centers))
    weight = forward + forward[::-1]  # 階級は0を中心に対称なので、逆向きは並びを返したもの
    used = weight > 0
    return GradeDistribution(centers[used], weight[used] / weight.sum())
