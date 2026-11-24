"""テストの区間の断面の点を、点の並び・区間の両端の標高・平均勾配から組む。"""

import numpy as np

from app.domain.elevation_profile import (
    FLAT,
    STEEPEST_MIN_INTERVAL_M,
    SUMMARY_COLUMNS,
    ElevationProfiles,
    GradeDistribution,
    ProfileSpans,
    along_fractions,
    profile_spans,
    profile_summaries,
)


def profiles(*rows: list[float | None], forward=None, distribution: GradeDistribution = FLAT,
             positions: list[list[float]] | None = None) -> ElevationProfiles:
    """区間の行ごとに、順方向に並べた点の標高（Noneは値の無い点）の断面。`forward`が偽の行は勾配の符号を返して読む。
    `positions`は行ごとの点の位置（区間の長さに対する割合）で、無ければ等しい間隔に置く。"""
    points = np.array([len(row) for row in rows], dtype=np.int32)
    elevation = np.array([np.nan if v is None else v for row in rows for v in row], dtype=np.float32)
    direction = np.ones(len(rows), dtype=bool) if forward is None else np.asarray(forward, dtype=bool)
    position = np.array([p for row, placed in zip(rows, positions or [()] * len(rows), strict=True)
                         for p in (placed if len(placed) else along_fractions((), len(row)))], dtype=np.float32)
    return ElevationProfiles(np.cumsum(points, dtype=np.int64) - points, points, direction, elevation, position,
                             distribution)


def grade_spans(gradient_percent: np.ndarray, distance_m: np.ndarray) -> ProfileSpans:
    """区間ごとに、平均勾配`gradient_percent`で一様に登る2点の断面の点の間。勾配がNaNの区間は点を持たず、平地で埋める。"""
    rise = np.asarray(gradient_percent, dtype=np.float64) / 100.0 * np.asarray(distance_m, dtype=np.float64)
    return profile_spans(profiles(*([] if np.isnan(r) else [0.0, float(r)] for r in rise)), distance_m)



def summarize_profile(elevations: list[float | None], along_m: list[float]) -> dict[str, float | None]:
    """1区間の断面（点の標高。Noneは値の無い点）と点の道のりの位置（m）を、道路網の配列と同じ要約（`profile_summaries`）に
    する。値の無い列はNone。区間の長さは最後の点の位置。"""
    positions = np.asarray(along_m, dtype=np.float64)
    summary = profile_summaries(
        np.zeros(1, dtype=np.int64), np.array([len(elevations)], dtype=np.int64), np.ones(1, dtype=np.bool_),
        np.array([np.nan if e is None else e for e in elevations], dtype=np.float32),
        along_fractions(positions, len(elevations)), positions[-1:], STEEPEST_MIN_INTERVAL_M)[0]
    return {name: None if np.isnan(value) else float(value) for name, value in zip(SUMMARY_COLUMNS, summary, strict=True)}
