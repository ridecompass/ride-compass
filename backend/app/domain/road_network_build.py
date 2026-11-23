"""道の事実から、取込範囲全体の道路網の配列（`domain/road_network.py: RoadNetwork`）を組む。

道の事実から安く導ける値は、ここで取込範囲全体について1回だけ求める: 区間と頂点の階級、端のそばの向きの欠け、
形の外接矩形、道の向き、断面から決まる値（要約・点の間・標高の無い長さ・気圧を出す標高。勾配の規則は
`domain/elevation_profile.py: interval_grade`の1つ）、断面から決まる材料（読み出した値を断面から求めた値で置き換える）、
数値の材料の平均。ルート生成と地図のレンズは
ここで出した値を読み、要求の中で求め直さない。
"""

from typing import Any

import numpy as np

from app.domain.attributes import STEEPEST_MIN_INTERVAL_M
from app.domain.elevation_profile import (
    SUMMARY_COLUMNS,
    ElevationProfiles,
    grade_distribution,
    profile_spans,
    profile_summaries,
)
from app.domain.geo import bearings_between
from app.domain.material_catalog import ELEVATION_GAIN_PER_KM, GRADIENT_PERCENT
from app.domain.road_network import RoadNetwork
from app.domain.search_graph import run_starts


def build_road_network(
    *, node_lat: np.ndarray, node_lon: np.ndarray, edge_way_id: np.ndarray, edge_segment: np.ndarray,
    edge_forward: np.ndarray, edge_from: np.ndarray, edge_to: np.ndarray, edge_rank: np.ndarray,
    edge_start_bearing_deg: np.ndarray, edge_end_bearing_deg: np.ndarray, edge_shape_start: np.ndarray,
    edge_shape_points: np.ndarray, shape_lon: np.ndarray, shape_lat: np.ndarray, numeric_ids: tuple[str, ...],
    numeric_values: np.ndarray, distance_m: np.ndarray, edge_profile_start: np.ndarray,
    edge_profile_points: np.ndarray, profile_elevation_m: np.ndarray, profile_position: np.ndarray, **facts: Any,
) -> RoadNetwork:
    """道の事実から`RoadNetwork`を組む。区間は有向の行（`RoadNetwork`の行順）で、端のそばの向きは形から決まらない区間がNaN。
    形と断面の点は、区間ごとに道の順方向に1回だけ、区間の行の順に隙間なく並べ、両向きの行が同じ点を指す。`facts`はそのまま
    写す`RoadNetwork`の欄。"""
    distance = np.asarray(distance_m, dtype=np.float64)
    first_of_edge = run_starts(edge_way_id) | run_starts(edge_segment)
    edge_of_row = np.cumsum(first_of_edge) - 1

    rank = np.asarray(edge_rank, dtype=np.int8)
    node_rank = node_max_ranks(len(node_lat), edge_from, edge_to, rank)

    shape_starts = np.asarray(edge_shape_start[first_of_edge], dtype=np.int64)
    bbox: dict[str, Any] = {name: reduce.reduceat(values, shape_starts)[edge_of_row] if len(shape_starts) else np.zeros(0)
            for name, reduce, values in (("edge_min_lon", np.minimum, shape_lon), ("edge_min_lat", np.minimum, shape_lat),
                                         ("edge_max_lon", np.maximum, shape_lon), ("edge_max_lat", np.maximum, shape_lat))}

    profile_start = np.asarray(edge_profile_start, dtype=np.int64)
    profile_points = np.asarray(edge_profile_points, dtype=np.int32)
    elevation = np.asarray(profile_elevation_m, dtype=np.float32)
    position = np.asarray(profile_position, dtype=np.float32)
    distribution = grade_distribution(profile_start[first_of_edge], profile_points[first_of_edge], elevation, position,
                                      distance[first_of_edge])
    spans = profile_spans(ElevationProfiles(profile_start, profile_points, np.asarray(edge_forward, dtype=bool),
                                            elevation, position, distribution), distance)
    summaries = dict(zip(SUMMARY_COLUMNS, profile_summaries(
        profile_start, profile_points.astype(np.int64), np.asarray(edge_forward, dtype=np.bool_), elevation, position,
        distance, STEEPEST_MIN_INTERVAL_M).T, strict=True))

    values = np.array(numeric_values, dtype=np.float64)
    gain_per_km = np.divide(summaries["elevation_gain_m"], distance / 1000.0, out=np.full(len(distance), np.nan),
                            where=distance > 0)
    for material_id, column in ((GRADIENT_PERCENT, summaries.pop("average_grade")), (ELEVATION_GAIN_PER_KM, gain_per_km)):
        if material_id in numeric_ids:
            values[:, numeric_ids.index(material_id)] = column

    return RoadNetwork(
        node_lat=node_lat, node_lon=node_lon, node_max_rank=node_rank,
        edge_way_id=edge_way_id, edge_segment=edge_segment, edge_forward=edge_forward, edge_from=edge_from,
        edge_to=edge_to, edge_rank=rank, **bbox,
        edge_start_bearing_deg=filled_bearings(edge_start_bearing_deg, node_lat, node_lon, edge_from, edge_to),
        edge_end_bearing_deg=filled_bearings(edge_end_bearing_deg, node_lat, node_lon, edge_from, edge_to),
        edge_shape_start=edge_shape_start, edge_shape_points=edge_shape_points, shape_lon=shape_lon, shape_lat=shape_lat,
        numeric_ids=numeric_ids, numeric_values=values, numeric_means=_numeric_means(numeric_ids, values, distance),
        distance_m=distance, way_bearing_deg=_way_bearings(node_lat, node_lon, edge_way_id, edge_forward, edge_from,
                                                          edge_to),
        **summaries, edge_profile_start=profile_start, edge_profile_points=profile_points,
        profile_elevation_m=elevation, profile_position=position,
        edge_span_start=spans.start, edge_span_count=spans.count, span_length_m=spans.length_m, span_grade=spans.grade,
        unknown_elevation_m=spans.unknown_m, mean_elevation_m=spans.mean_elevation_m,
        **facts,
    )


def filled_bearings(bearing_deg: np.ndarray, node_lat: np.ndarray, node_lon: np.ndarray, edge_from: np.ndarray,
                    edge_to: np.ndarray) -> np.ndarray:
    """区間の端のそばの向き。形から決まらない（NaNの）区間は、始点の頂点から終点の頂点を見た向きで埋める。"""
    bearing = np.asarray(bearing_deg, dtype=np.float64)
    chord = bearings_between(node_lat[edge_from], node_lon[edge_from], node_lat[edge_to], node_lon[edge_to])
    return np.where(np.isnan(bearing), chord, bearing)


def node_max_ranks(node_count: int, edge_from: np.ndarray, edge_to: np.ndarray, edge_rank: np.ndarray) -> np.ndarray:
    """頂点ごとの、そこへ入る区間と出る区間の一番高い階級（区間の無い頂点は0）。一方通行の道が出ていくだけの頂点も、その道の
    階級を持つ。"""
    rank = np.zeros(node_count, dtype=np.asarray(edge_rank).dtype)
    np.maximum.at(rank, edge_from, edge_rank)
    np.maximum.at(rank, edge_to, edge_rank)
    return rank


def _numeric_means(numeric_ids: tuple[str, ...], values: np.ndarray, distance_m: np.ndarray) -> dict[str, float]:
    """数値の材料ごとの、距離で重みを付けた平均（値の無い区間を除く。値が1つも無ければNaN）。"""
    means: dict[str, float] = {}
    for column, material_id in enumerate(numeric_ids):
        known = ~np.isnan(values[:, column])
        total = float(distance_m[known].sum())
        means[material_id] = float((values[known, column] * distance_m[known]).sum()) / total if total > 0 else np.nan
    return means


def _way_bearings(node_lat: np.ndarray, node_lon: np.ndarray, way: np.ndarray, forward: np.ndarray,
                  edge_from: np.ndarray, edge_to: np.ndarray) -> np.ndarray:
    """区間の行ごとの、その道の順方向の始点（一番若い区間の始まり）から終点（一番後の区間の終わり）を見た方位。"""
    first_of_way = run_starts(way)
    first = np.flatnonzero(first_of_way)
    last = np.r_[first[1:], len(way)][:len(first)] - 1
    tail = np.where(forward[first], edge_from[first], edge_to[first])
    head = np.where(forward[last], edge_to[last], edge_from[last])
    return bearings_between(node_lat[tail], node_lon[tail], node_lat[head], node_lon[head])[np.cumsum(first_of_way) - 1]
