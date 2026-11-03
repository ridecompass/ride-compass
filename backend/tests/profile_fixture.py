"""テストの区間の断面の点を、区間の両端の標高や平均勾配から組む。"""

import numpy as np
from app.domain.elevation_profile import ElevationProfiles, GradeDistribution

#: 標高の無い所を平地で埋める分布。
FLAT = GradeDistribution(np.zeros(1), np.ones(1))


def two_point_profiles(start_elevation_m: np.ndarray, end_elevation_m: np.ndarray,
                       forward: np.ndarray) -> dict[str, np.ndarray]:
    """道路網（`domain/road_network.py: RoadNetwork`）の断面の欄。区間の行ごとに、走る向きの始まりと終わりの2点を
    道の順方向に並べて持つ（逆向きの行は逆に読まれる）。標高の無い行（始まりがNaN）は点を持たず、平地で埋める。"""
    start = np.asarray(start_elevation_m, dtype=np.float32)
    end = np.asarray(end_elevation_m, dtype=np.float32)
    forward = np.asarray(forward, dtype=bool)
    points = np.where(np.isnan(start), 0, 2).astype(np.int32)
    ordered = np.column_stack([np.where(forward, start, end), np.where(forward, end, start)])
    return {
        "edge_profile_start": (np.cumsum(points, dtype=np.int64) - points).astype(np.int64),
        "edge_profile_points": points,
        "profile_elevation_m": ordered[points > 0].ravel().astype(np.float32),
        "profile_distribution_grade": FLAT.grade,
        "profile_distribution_share": FLAT.share,
    }


def grade_profiles(gradient_percent: np.ndarray, distance_m: np.ndarray) -> ElevationProfiles:
    """区間ごとに、平均勾配`gradient_percent`で一様に登る2点の断面。勾配がNaNの区間は点を持たず、平地で埋める。"""
    gradient = np.asarray(gradient_percent, dtype=np.float64)
    rise = gradient / 100.0 * np.asarray(distance_m, dtype=np.float64)
    forward = np.ones(len(gradient), dtype=bool)
    fields = two_point_profiles(np.where(np.isnan(gradient), np.nan, 0.0), rise, forward)
    return ElevationProfiles(fields["edge_profile_start"], fields["edge_profile_points"], ~forward,
                             fields["profile_elevation_m"], FLAT)
