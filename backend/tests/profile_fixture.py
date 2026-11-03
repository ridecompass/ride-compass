"""テストの道路網（`domain/road_network.py: RoadNetwork`）の断面の点の欄を、区間の両端の標高から組む。"""

import numpy as np


def two_point_profiles(start_elevation_m: np.ndarray, end_elevation_m: np.ndarray) -> dict[str, np.ndarray]:
    """区間ごとに両端の2点の断面（`edge_profile_start`・`edge_profile_points`・`profile_elevation_m`）。標高の無い
    区間（始まりがNaN）は点を持たない。"""
    start = np.asarray(start_elevation_m, dtype=np.float32)
    end = np.asarray(end_elevation_m, dtype=np.float32)
    points = np.where(np.isnan(start), 0, 2).astype(np.int32)
    elevation = np.column_stack([start, end])[points > 0].ravel()
    return {
        "edge_profile_start": (np.cumsum(points, dtype=np.int64) - points).astype(np.int64),
        "edge_profile_points": points,
        "profile_elevation_m": elevation.astype(np.float32),
    }
