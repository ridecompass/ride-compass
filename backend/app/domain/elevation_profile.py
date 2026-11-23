"""区間の断面の点の並び（標高）と、所要時間と体力を求める単位の「点の間」の勾配。

断面の点は、区間に沿って拾った標高を揺れの閾値で間引いた点（`infrastructure/derived_models.py: EdgeElevationRow.elevation_profile_m`）で、
点の間隔はそろわない。道路網の配列は全区間の点を順方向に並べてつないだ1本の標高の配列と、点ごとの位置（区間の長さに対する
割合。始まりが0、終わりが1）の配列と、向きつきの行ごとの始まりの位置・点の数・順方向かで持つ（区間の両向きの行は同じ点を指し、
逆向きの行は勾配の符号を返して読む）。点の間の長さは、区間の長さ×（隣の点との位置の差）。

**点の間は、道路網の配列を作るときに1回だけJITで平らな並びに詰める**（`profile_spans`。区間の行ごとの範囲で持ち、探索は
範囲の区間の行の分を写すだけ）。所要時間は探索の範囲の全区間について風の時刻ごとに解くため、numpyで点の間（区間の数倍）の
配列を組むと、それだけで探索が1秒前後遅くなる。断面から決まる区間の値（端の標高・獲得と喪失・平均勾配・一番急な所。
`profile_summaries`）も、配列を作るときにここで出す。

**このファイルのJITの関数どうしは、このファイルの中で呼び合う**。numbaのキャッシュは呼ぶ側のファイルの更新しか見ないので、
別のファイルのJITの関数から`interval_grade`を呼ぶと、ここを直しても呼ぶ側が直す前の判定のまま動く。

**標高の無い所は、全体の勾配の分布どおりの坂で走る**（分布の平均の1つの坂にしない）。点が2つ未満の区間と、どちらかの端に値の無い点の間と、公道としてありえない
勾配の間（標高データの読み違い）は、区間ごとに長さを足し合わせ（`unknown_lengths_m`）、道路網全体の点の間の勾配の分布
（距離の重み）どおりの坂で走る——平地とみなすと、標高の無い道が坂の無い速い道に見える。分布は道路網を組むときに1回だけ
求め（`grade_distribution`）、探索の範囲には依らない。
"""

from dataclasses import dataclass

import numpy as np
from numba import njit
from numpy.typing import ArrayLike

#: 舗装された公道としてありうる勾配の上限（%）。世界でも最急の公道が35%前後のため、これを超える値は道の起伏ではなく
#: 標高データの読み違い（両端が路面でない地物を指した等）である。点の間の勾配がこれを超えたら、その間を勾配として
#: 数えない——0次ハードフィルタは値の無い区間を除外しない（`domain/hard_filters.py`）ので、誤った値で黙って経路から
#: 外すより安全側になる。
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
    position: np.ndarray  # float32、点ごとの位置（区間の長さに対する割合）
    distribution: GradeDistribution

    def take(self, rows: np.ndarray) -> "ElevationProfiles":
        return ElevationProfiles(np.asarray(self.start[rows]), np.asarray(self.points[rows]),
                                 np.asarray(self.forward[rows]), self.elevation_m, self.position, self.distribution)


def along_fractions(along_m: ArrayLike, points: int) -> np.ndarray:
    """1区間の点の道のりの位置（m）を、区間の長さに対する割合（float32）にする。位置が点の数と合わない（持たない）か区間の
    長さが0なら、`points`個の点を等しい間隔に置く。"""
    along = np.asarray(along_m, dtype=np.float32)
    if len(along) == points >= 2 and along[-1] > 0:
        return along / along[-1]
    return np.linspace(0.0, 1.0, points, dtype=np.float32)


@njit(cache=True, nogil=True)
def interval_grade(lower_m: float, upper_m: float, length_m: float) -> float:
    """点の間の、順方向に読んだ勾配（小数）。どちらかの端に値が無いか、公道としてありえない勾配ならNaN（標高の無い間）。
    長さ0の間（長さ0の区間）も勾配を持たない——走る長さが無いので、所要時間にも標高の無い長さにも効かない。
    所要時間・標高の無い長さ・区間の要約（`profile_summaries`）は、どれもこの判定で数える間を決める。"""
    if not length_m > 0:
        return np.nan
    grade = (upper_m - lower_m) / length_m
    if not abs(grade) <= _MAX_PLAUSIBLE_GRADE:  # NaNもここで外れる
        return np.nan
    return grade


@njit(cache=True, nogil=True)
def unknown_lengths_m(start: np.ndarray, points: np.ndarray, elevation_m: np.ndarray, position: np.ndarray,
                      distance_m: np.ndarray) -> np.ndarray:
    """区間の行ごとの、標高の無い長さ（m）の和。点が2つ未満の区間は区間全体。"""
    unknown = np.zeros(len(points))
    for row in range(len(points)):
        count = points[row]
        if count < 2:
            unknown[row] = distance_m[row]
            continue
        first = start[row]
        for i in range(count - 1):
            step = distance_m[row] * (position[first + i + 1] - position[first + i])
            if np.isnan(interval_grade(elevation_m[first + i], elevation_m[first + i + 1], step)):
                unknown[row] += step
    return unknown


@njit(cache=True, nogil=True)
def row_elevations_m(start: np.ndarray, points: np.ndarray, elevation_m: np.ndarray) -> np.ndarray:
    """区間の行ごとの標高（m）。断面の点のうち値のある点の標高の平均で、値のある点が無い行はNaN。"""
    mean = np.full(len(points), np.nan)
    for row in range(len(points)):
        total = 0.0
        known = 0
        for i in range(start[row], start[row] + points[row]):
            if not np.isnan(elevation_m[i]):
                total += elevation_m[i]
                known += 1
        if known:
            mean[row] = total / known
    return mean


@njit(cache=True, nogil=True)
def flatten_spans(start: np.ndarray, points: np.ndarray, forward: np.ndarray, elevation_m: np.ndarray,
                   position: np.ndarray, distance_m: np.ndarray, unknown_m: np.ndarray, fill_grade: np.ndarray,
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
            sign = 1.0 if forward[row] else -1.0
            first = start[row]
            for i in range(count - 1):
                step = distance_m[row] * (position[first + i + 1] - position[first + i])
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


@dataclass(frozen=True)
class ProfileSpans:
    """区間の行ごとの、所要時間と体力を解く点の間（`flatten_spans`の並び。行ごとに`start`から`count`個で、`length_m`・`grade`は
    全行が共有する）と、行ごとの標高の無い長さと、気圧を出す標高（値のある点の標高の平均。値のある点が無ければNaN）。"""

    start: np.ndarray  # int64
    count: np.ndarray  # int32
    length_m: np.ndarray  # float32
    grade: np.ndarray  # float32、走る向きの勾配（小数）
    unknown_m: np.ndarray  # float64
    mean_elevation_m: np.ndarray  # float64

    def take(self, rows: np.ndarray) -> "ProfileSpans":
        return ProfileSpans(np.asarray(self.start[rows]), np.asarray(self.count[rows]), self.length_m, self.grade,
                            np.asarray(self.unknown_m[rows]), np.asarray(self.mean_elevation_m[rows]))

    def flat(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """`(行, 長さ, 走る向きの勾配)`の平らな並び（行はこの束の中の位置）。"""
        count = np.asarray(self.count, dtype=np.int64)
        # 行ごとの範囲 [始まり, 始まり＋数) をつないだ位置（行の先頭からの位置 ＋ 行の始まり）。
        offset = np.asarray(self.start, dtype=np.int64) - (np.cumsum(count) - count)
        taken = np.repeat(offset, count) + np.arange(int(count.sum()))
        return (np.repeat(np.arange(len(count), dtype=np.int32), count),
                np.asarray(self.length_m[taken], dtype=np.float32), np.asarray(self.grade[taken], dtype=np.float32))


def profile_spans(profiles: ElevationProfiles, distance_m: np.ndarray) -> ProfileSpans:
    """区間の行ごとの断面`profiles`と長さ`distance_m`から、所要時間と体力を解く点の間を作る。"""
    start = np.asarray(profiles.start, dtype=np.int64)
    points = np.asarray(profiles.points, dtype=np.int64)
    elevation = np.asarray(profiles.elevation_m, dtype=np.float32)
    position = np.asarray(profiles.position, dtype=np.float32)
    distance = np.asarray(distance_m, dtype=np.float64)
    unknown = unknown_lengths_m(start, points, elevation, position, distance)
    span_row, length, grade = flatten_spans(
        start, points, np.asarray(profiles.forward, dtype=np.bool_), elevation, position, distance, unknown,
        np.asarray(profiles.distribution.grade, dtype=np.float64), np.asarray(profiles.distribution.share, dtype=np.float64))
    count = np.bincount(span_row, minlength=len(points)).astype(np.int32)
    return ProfileSpans(np.cumsum(count, dtype=np.int64) - count, count, length, grade, unknown,
                        row_elevations_m(start, points, elevation))


#: 区間の要約（`profile_summaries`の列の並び）。
SUMMARY_COLUMNS = ("start_elevation_m", "end_elevation_m", "elevation_gain_m", "elevation_loss_m", "average_grade",
                   "steepest_gain_percent", "steepest_loss_percent")


@njit(cache=True, nogil=True)
def _steepest_climb(elevation: np.ndarray, along: np.ndarray, min_interval_m: float) -> float:
    """点を並べた向きに走ったときの一番急な登り（%、0以上）。測れる候補が無ければNaN。

    GraphHopper の`SlopeCalculator`の max_slope の式（https://github.com/graphhopper/graphhopper/blob/master/core/src/main/java/com/graphhopper/routing/util/SlopeCalculator.java）:
    3点目からの点ごとに、1つ前の2点の標高の平均から今の点までの勾配（長さは今の間と前の間の半分の和）を、今の間と前の間が
    どちらも数える間で、前の間が`min_interval_m`より長いときだけ候補にする。数える間の途切れない続きごとに、続きの両端の勾配も、
    続きの長さが`min_interval_m`以上なら候補にする（欠けた所をまたいで均さない）。短い間ほど標高データの揺れが勾配を大きく揺らす。"""
    best = np.nan
    run_rise = 0.0
    run_length = 0.0
    previous_counted = False
    for k in range(1, len(elevation) + 1):
        counted = False
        if k < len(elevation):
            step = along[k] - along[k - 1]
            counted = not np.isnan(interval_grade(elevation[k - 1], elevation[k], step))
        if counted:
            rise = elevation[k] - elevation[k - 1]
            if previous_counted and along[k - 1] - along[k - 2] > min_interval_m:
                before = elevation[k - 1] - elevation[k - 2]
                slope = max((rise + before / 2) / (step + (along[k - 1] - along[k - 2]) / 2) * 100.0, 0.0)
                best = slope if np.isnan(best) else max(best, slope)
            run_rise += rise
            run_length += step
        elif run_length > 0:
            if run_length >= min_interval_m:
                slope = max(run_rise / run_length * 100.0, 0.0)
                best = slope if np.isnan(best) else max(best, slope)
            run_rise = 0.0
            run_length = 0.0
        previous_counted = counted
    return best


@njit(cache=True, nogil=True)
def profile_summaries(start: np.ndarray, points: np.ndarray, forward: np.ndarray, elevation_m: np.ndarray,
                      position: np.ndarray, distance_m: np.ndarray, min_interval_m: float) -> np.ndarray:
    """区間の行ごとの、走る向きに見た要約（`(行, SUMMARY_COLUMNS)`の float64）。値のある点が2つ未満の行はどれもNaN。

    要約は、隣り合う2点の間のうち勾配として数える間（`interval_grade`）だけから出す。獲得・喪失は数える間の登りと下りの和
    （数える間が無ければ0）、平均勾配（%）は（獲得−喪失）÷数える間の長さの和で、数える間が無ければNaN。一番急な登りと下りは
    `_steepest_climb`を走る向きと逆の向きに並べた点に当てる（下りは、逆向きに走ったときの一番急な登り）。"""
    summaries = np.full((len(points), 7), np.nan)
    for row in range(len(points)):
        count = points[row]
        elevation = np.empty(count)
        along = np.empty(count)
        for i in range(count):
            source = start[row] + (i if forward[row] else count - 1 - i)
            elevation[i] = elevation_m[source]
            at = position[source] if forward[row] else 1.0 - position[source]
            along[i] = distance_m[row] * at
        known = elevation[~np.isnan(elevation)]
        if len(known) < 2:
            continue
        gain = 0.0
        loss = 0.0
        counted_m = 0.0
        for k in range(1, count):
            step = along[k] - along[k - 1]
            if not np.isnan(interval_grade(elevation[k - 1], elevation[k], step)):
                rise = elevation[k] - elevation[k - 1]
                gain += max(rise, 0.0)
                loss += max(-rise, 0.0)
                counted_m += step
        summaries[row, 0] = known[0]
        summaries[row, 1] = known[-1]
        summaries[row, 2] = gain
        summaries[row, 3] = loss
        if counted_m > 0:
            summaries[row, 4] = (gain - loss) / counted_m * 100.0
        summaries[row, 5] = _steepest_climb(elevation, along, min_interval_m)
        summaries[row, 6] = _steepest_climb(elevation[::-1].copy(), along[-1] - along[::-1], min_interval_m)
    return summaries


@njit(cache=True, nogil=True)
def _known_grades(start: np.ndarray, points: np.ndarray, elevation_m: np.ndarray, position: np.ndarray,
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
        first = start[row]
        for i in range(count - 1):
            step = distance_m[row] * (position[first + i + 1] - position[first + i])
            grade = interval_grade(elevation_m[first + i], elevation_m[first + i + 1], step)
            if not np.isnan(grade):
                grades[found] = grade
                lengths[found] = step
                found += 1
    return grades[:found], lengths[:found]


def grade_distribution(start: np.ndarray, points: np.ndarray, elevation_m: np.ndarray, position: np.ndarray,
                       distance_m: np.ndarray) -> GradeDistribution:
    """区間ごとに1行で渡した点の間の勾配の分布（道のりの重み）。どの向きにも走るので、順方向に読んだ勾配と、その逆向き
    （符号を返した勾配）を半分ずつ数える。値のある間が1つも無ければ、平地だけの分布。"""
    grades, lengths = _known_grades(np.asarray(start, dtype=np.int64), np.asarray(points, dtype=np.int64),
                                    np.asarray(elevation_m, dtype=np.float32), np.asarray(position, dtype=np.float32),
                                    np.asarray(distance_m, dtype=np.float64))
    if len(grades) == 0:
        return FLAT
    centers = np.arange(-_DISTRIBUTION_LIMIT, _DISTRIBUTION_LIMIT + _DISTRIBUTION_STEP / 2, _DISTRIBUTION_STEP)
    bins = np.clip(np.rint(grades / _DISTRIBUTION_STEP).astype(np.int64) + len(centers) // 2, 0, len(centers) - 1)
    forward = np.bincount(bins, weights=lengths, minlength=len(centers))
    weight = forward + forward[::-1]  # 階級は0を中心に対称なので、逆向きは並びを返したもの
    used = weight > 0
    return GradeDistribution(centers[used], weight[used] / weight.sum())
