"""テストの区間の断面の点を、点の並び・区間の両端の標高・平均勾配から組む。"""

import numpy as np

from app.domain.elevation_profile import FLAT, ElevationProfiles, GradeDistribution


def profiles(*rows: list[float | None], forward=None, distribution: GradeDistribution = FLAT) -> ElevationProfiles:
    """区間の行ごとに、順方向に並べた点の標高（Noneは値の無い点）の断面。`forward`が偽の行は勾配の符号を返して読む。"""
    points = np.array([len(row) for row in rows], dtype=np.int32)
    elevation = np.array([np.nan if v is None else v for row in rows for v in row], dtype=np.float32)
    direction = np.ones(len(rows), dtype=bool) if forward is None else np.asarray(forward, dtype=bool)
    return ElevationProfiles(np.cumsum(points, dtype=np.int64) - points, points, direction, elevation, distribution)


def grade_profiles(gradient_percent: np.ndarray, distance_m: np.ndarray) -> ElevationProfiles:
    """区間ごとに、平均勾配`gradient_percent`で一様に登る2点の断面。勾配がNaNの区間は点を持たず、平地で埋める。"""
    rise = np.asarray(gradient_percent, dtype=np.float64) / 100.0 * np.asarray(distance_m, dtype=np.float64)
    return profiles(*([] if np.isnan(r) else [0.0, float(r)] for r in rise))


def two_point_profiles(start_elevation_m: np.ndarray, end_elevation_m: np.ndarray,
                       forward: np.ndarray) -> dict[str, np.ndarray]:
    """道路網（`domain/road_network.py: RoadNetwork`）の断面の欄。区間の行ごとに、走る向きの始まりと終わりの2点を
    道の順方向に並べて持つ。標高の無い行（始まりがNaN）は点を持たず、平地で埋める。"""
    forward = np.asarray(forward, dtype=bool)
    built = profiles(*([] if np.isnan(a) else ([a, b] if f else [b, a])
                       for a, b, f in zip(start_elevation_m, end_elevation_m, forward, strict=True)))
    return {
        "edge_profile_start": built.start, "edge_profile_points": built.points, "profile_elevation_m": built.elevation_m,
        "profile_distribution_grade": FLAT.grade, "profile_distribution_share": FLAT.share,
    }
