"""テストの取込範囲全体の道路網（`domain/road_network.py: RoadNetwork`）を、ノードの地点・区間の両端・区間の両端の標高・材料から組む。

テストが`RoadNetwork`を組むのはここだけ。区間の形は両端のノードを結ぶ直線で、区間の長さ・方位・外接矩形・中点は
その直線から、標高の要約（獲得・損失・一番急な勾配）と平均勾配の材料（`GRADIENT_PERCENT`）は両端の標高の2点の断面から、
断面の分布はその断面から本番の関数（`domain/geo.py`・`domain/elevation_profile.py`）で導く。方位は2点が同じ区間だけNaN。
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

import numpy as np

from app.domain.attributes import STEEPEST_MIN_INTERVAL_M, CategoricalColumn
from app.domain.elevation_profile import grade_distribution, interval_grade
from app.domain.geo import bearings_between, haversine_distance_km_pairs
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.road_network import RoadNetwork
from tests.tuning_fixture import TUNING


@dataclass(frozen=True)
class EdgeRows:
    """有向の区間の行（`RoadNetwork`の行順）の、道・区間番号・順方向か。材料を行ごとに返す関数へ渡す。"""

    way: np.ndarray
    segment: np.ndarray
    forward: np.ndarray


#: 行ごとの材料の値を返す関数。数値はNaNが値なし、分類はNoneが値なし。
NumericMaterial = Callable[[EdgeRows], Sequence[float] | np.ndarray]
CategoricalMaterial = Callable[[EdgeRows], Sequence[str | None]]


def road_network(
    coordinates: Mapping[int, tuple[float, float]],
    segments: Mapping[tuple[int, int], tuple[int, int]],
    *, oneway: Sequence[tuple[int, int]] = (), elevation_of: Mapping[tuple[int, int], tuple[float, float]] | None = None,
    numeric: Mapping[str, NumericMaterial] | None = None, categorical: Mapping[str, CategoricalMaterial] | None = None,
    signal_nodes: Sequence[int] = (), max_rank_of: Mapping[int, int] | None = None, revision: int = 1,
) -> RoadNetwork:
    """`coordinates`はノード（osm_node_id → (緯度, 経度)）、`segments`は区間（(道, 区間番号) → (始点, 終点)のノード）。

    `oneway`の区間は始点→終点の向きだけを持つ。`elevation_of`（区間 → (始点, 終点)の標高m）の区間だけ標高を持ち、
    ほかは標高も勾配の値も無い。`numeric`・`categorical`は材料のid → 行ごとの値。集まる道の本数は、区間の端として
    現れる回数。"""
    node_ids = np.array(sorted({osm for pair in segments.values() for osm in pair}), dtype=np.int64)
    row_of = {int(osm): i for i, osm in enumerate(node_ids)}
    lat = np.array([coordinates[int(osm)][0] for osm in node_ids], dtype=np.float64)
    lon = np.array([coordinates[int(osm)][1] for osm in node_ids], dtype=np.float64)

    one_direction = set(oneway)
    directed = [(way, segment, forward, (start, end) if forward else (end, start))
                for (way, segment), (start, end) in sorted(segments.items())
                for forward in (True, False) if forward or (way, segment) not in one_direction]
    rows = EdgeRows(np.array([way for way, *_ in directed], dtype=np.int64),
                    np.array([segment for _, segment, *_ in directed], dtype=np.int32),
                    np.array([forward for _, _, forward, _ in directed], dtype=bool))
    tail = np.array([row_of[a] for *_, (a, _b) in directed], dtype=np.int32)
    head = np.array([row_of[b] for *_, (_a, b) in directed], dtype=np.int32)

    distance_m = haversine_distance_km_pairs(lat[tail], lon[tail], lat[head], lon[head]) * 1000.0
    same_point = (lat[tail] == lat[head]) & (lon[tail] == lon[head])
    bearing = np.where(same_point, np.nan, bearings_between(lat[tail], lon[tail], lat[head], lon[head]))

    # 道の順方向の両端の標高を、行の向きの始まりと終わりへ並べる。
    along = np.array([(elevation_of or {}).get((int(w), int(s)), (np.nan, np.nan)) for w, s in zip(
        rows.way, rows.segment, strict=True)], dtype=np.float64).reshape(-1, 2)
    start_elevation = np.where(rows.forward, along[:, 0], along[:, 1])
    end_elevation = np.where(rows.forward, along[:, 1], along[:, 0])
    elevation = _two_point_summaries(start_elevation, end_elevation, distance_m)

    materials = {**{name: np.asarray(values(rows), dtype=np.float64) for name, values in (numeric or {}).items()},
                 GRADIENT_PERCENT: elevation.pop("average_grade")}
    classes = {name: CategoricalColumn.encode(values(rows)) for name, values in (categorical or {}).items()}

    return RoadNetwork(
        revision=revision, stop_cluster_distance_m=TUNING["stop.cluster_distance_m"],
        node_osm_id=node_ids, node_lat=lat, node_lon=lon,
        node_has_signals=np.isin(node_ids, list(signal_nodes)),
        node_max_rank=np.array([(max_rank_of or {}).get(int(osm), 0) for osm in node_ids], dtype=np.int64),
        node_branch_count=np.bincount(
            [row_of[osm] for pair in segments.values() for osm in pair], minlength=len(node_ids)).astype(np.int16),
        edge_way_id=rows.way, edge_segment=rows.segment, edge_forward=rows.forward, edge_from=tail, edge_to=head,
        edge_highway=np.zeros(len(directed), dtype=np.int16), highway_vocab=("residential",),
        edge_min_lon=np.minimum(lon[tail], lon[head]), edge_min_lat=np.minimum(lat[tail], lat[head]),
        edge_max_lon=np.maximum(lon[tail], lon[head]), edge_max_lat=np.maximum(lat[tail], lat[head]),
        edge_start_bearing_deg=bearing, edge_end_bearing_deg=bearing,
        numeric_ids=tuple(materials), numeric_values=np.column_stack(list(materials.values())),
        categorical_ids=tuple(classes),
        categorical_codes=np.column_stack([c.codes for c in classes.values()]).astype(np.int16) if classes
        else np.zeros((len(directed), 0), dtype=np.int16),
        categorical_vocab=tuple(c.vocab for c in classes.values()),
        distance_m=distance_m, bearing_deg=bearing,
        mid_lat=(lat[tail] + lat[head]) / 2, mid_lon=(lon[tail] + lon[head]) / 2,
        start_elevation_m=start_elevation, end_elevation_m=end_elevation,
        **elevation,
        **_profiles(rows, along, distance_m),
    )


def _two_point_summaries(start_m: np.ndarray, end_m: np.ndarray, distance_m: np.ndarray) -> dict[str, np.ndarray]:
    """両端の2点だけの断面の、標高の要約と平均勾配（%）。点の間を勾配として数えるかは`interval_grade`で決め、数えない区間は
    獲得・損失が0で勾配を持たない。標高の無い区間はどれも値なし。一番急な勾配は、点の間が`STEEPEST_MIN_INTERVAL_M`以上の
    ときだけ持つ。"""
    grade = np.array([interval_grade(a, b, d) for a, b, d in zip(start_m, end_m, distance_m, strict=True)]) * 100
    known = ~np.isnan(start_m)
    counted = ~np.isnan(grade)
    climb = np.where(counted, end_m - start_m, 0.0)
    steep = np.where(counted & (distance_m >= STEEPEST_MIN_INTERVAL_M), grade, np.nan)
    return {
        "elevation_gain_m": np.where(known, np.maximum(climb, 0.0), np.nan),
        "elevation_loss_m": np.where(known, np.maximum(-climb, 0.0), np.nan),
        "steepest_gain_percent": np.maximum(steep, 0.0), "steepest_loss_percent": np.maximum(-steep, 0.0),
        "average_grade": grade,
    }


def _profiles(rows: EdgeRows, along: np.ndarray, distance_m: np.ndarray) -> dict[str, np.ndarray]:
    """断面の欄。点は区間ごとに道の順方向に1回だけ持ち、両向きの行は同じ点を指す。分布は`grade_distribution`で求める。"""
    first = np.ones(len(rows.way), dtype=bool)
    first[1:] = (rows.way[1:] != rows.way[:-1]) | (rows.segment[1:] != rows.segment[:-1])
    owner = np.cumsum(first) - 1
    unique = np.flatnonzero(first)
    points = np.where(np.isnan(along[unique, 0]), 0, 2).astype(np.int32)
    starts = np.cumsum(points, dtype=np.int64) - points
    elevation = along[unique][points > 0].ravel().astype(np.float32)
    position = np.tile(np.array([0.0, 1.0], dtype=np.float32), int((points > 0).sum()))
    distribution = grade_distribution(starts, points, elevation, position, distance_m[unique])
    return {
        "edge_profile_start": starts[owner], "edge_profile_points": points[owner], "profile_elevation_m": elevation,
        "profile_position": position,
        "profile_distribution_grade": distribution.grade, "profile_distribution_share": distribution.share,
    }
