"""テストの取込範囲全体の道路網（`domain/road_network.py: RoadNetwork`）を、ノードの地点・区間の両端・区間の両端の標高・材料から組む。

テストが`RoadNetwork`を組むのはここだけ。区間の形は両端のノードを結ぶ直線で、区間の長さ・方位・中点はその直線から、断面は
両端の標高の2点で渡し、そこから導く値（階級・外接矩形・標高の要約・平均勾配の材料`GRADIENT_PERCENT`・点の間）は本番と同じく
`domain/road_network_build.py: build_road_network`が求める。方位は2点が同じ区間だけNaN。区間の階級はどれも生活道路の階級。
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

import numpy as np

from app.domain.attributes import CategoricalColumn
from app.domain.geo import bearings_between, haversine_distance_km_pairs
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.road_network import RoadNetwork
from app.domain.road_network_build import EdgelessWays, build_road_network
from app.domain.traffic import highway_rank
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
    *, oneway: Sequence[tuple[int, int]] = (), backward: Sequence[tuple[int, int]] = (), elevation_of: Mapping[tuple[int, int], tuple[float, float]] | None = None,
    numeric: Mapping[str, NumericMaterial] | None = None, categorical: Mapping[str, CategoricalMaterial] | None = None,
    signal_nodes: Sequence[int] = (), edgeless: EdgelessWays | None = None, revision: int = 1,
) -> RoadNetwork:
    """`coordinates`はノード（osm_node_id → (緯度, 経度)）、`segments`は区間（(道, 区間番号) → (始点, 終点)のノード）。

    `oneway`の区間は始点→終点の向きだけを、`backward`の区間は終点→始点の向きだけを持つ。`elevation_of`（区間 → (始点, 終点)の標高m）の区間だけ標高を持ち、
    ほかは標高も勾配の値も無い。`numeric`・`categorical`は材料のid → 行ごとの値。集まる道の本数は、区間の端として
    現れる回数。`edgeless`は区間を持たない道（材料の列は`numeric`の順に`GRADIENT_PERCENT`を足した並びと、`categorical`の並び）。"""
    node_ids = np.array(sorted({osm for pair in segments.values() for osm in pair}), dtype=np.int64)
    row_of = {int(osm): i for i, osm in enumerate(node_ids)}
    lat = np.array([coordinates[int(osm)][0] for osm in node_ids], dtype=np.float64)
    lon = np.array([coordinates[int(osm)][1] for osm in node_ids], dtype=np.float64)

    ordered = sorted(segments.items())
    without = {(edge, False) for edge in oneway} | {(edge, True) for edge in backward}
    directed = [(way, segment, forward, (start, end) if forward else (end, start), edge)
                for edge, ((way, segment), (start, end)) in enumerate(ordered)
                for forward in (True, False) if ((way, segment), forward) not in without]
    rows = EdgeRows(np.array([way for way, *_ in directed], dtype=np.int64),
                    np.array([segment for _, segment, *_ in directed], dtype=np.int32),
                    np.array([forward for _, _, forward, *_ in directed], dtype=bool))
    owner = np.array([edge for *_, edge in directed], dtype=np.int64)
    tail = np.array([row_of[a] for *_, (a, _b), _ in directed], dtype=np.int32)
    head = np.array([row_of[b] for *_, (_a, b), _ in directed], dtype=np.int32)

    distance_m = haversine_distance_km_pairs(lat[tail], lon[tail], lat[head], lon[head]) * 1000.0
    same_point = (lat[tail] == lat[head]) & (lon[tail] == lon[head])
    bearing = np.where(same_point, np.nan, bearings_between(lat[tail], lon[tail], lat[head], lon[head]))

    # 形と断面の点は区間ごとに道の順方向で1回だけ持つ（形は両端の2点、断面は標高のある区間だけ両端の2点）。
    ends = np.array([[row_of[start], row_of[end]] for _, (start, end) in ordered], dtype=np.int64).reshape(-1, 2)
    along = np.array([(elevation_of or {}).get(edge, (np.nan, np.nan)) for edge, _ in ordered],
                     dtype=np.float64).reshape(-1, 2)
    profile_points = np.where(np.isnan(along[:, 0]), 0, 2).astype(np.int32)
    profile_start = np.cumsum(profile_points, dtype=np.int64) - profile_points

    materials = {**{name: np.asarray(values(rows), dtype=np.float64) for name, values in (numeric or {}).items()},
                 GRADIENT_PERCENT: np.full(len(directed), np.nan)}
    classes = {name: CategoricalColumn.encode(values(rows)) for name, values in (categorical or {}).items()}

    return build_road_network(
        revision=revision, stop_cluster_distance_m=TUNING["stop.cluster_distance_m"],
        node_osm_id=node_ids, node_lat=lat, node_lon=lon, node_has_signals=np.isin(node_ids, list(signal_nodes)),
        node_branch_count=np.bincount(
            [row_of[osm] for pair in segments.values() for osm in pair], minlength=len(node_ids)).astype(np.int16),
        edge_way_id=rows.way, edge_segment=rows.segment, edge_forward=rows.forward, edge_from=tail, edge_to=head,
        edge_rank=np.full(len(directed), highway_rank("residential"), dtype=np.int8),
        edge_start_bearing_deg=bearing, edge_end_bearing_deg=bearing,
        edge_shape_start=owner * 2, edge_shape_points=np.full(len(directed), 2, dtype=np.int32),
        shape_lon=lon[ends].ravel(), shape_lat=lat[ends].ravel(),
        numeric_ids=tuple(materials), numeric_values=np.column_stack(list(materials.values())),
        categorical_ids=tuple(classes),
        categorical_codes=np.column_stack([c.codes for c in classes.values()]).astype(np.int16) if classes
        else np.zeros((len(directed), 0), dtype=np.int16),
        categorical_vocab=tuple(c.vocab for c in classes.values()),
        distance_m=distance_m, bearing_deg=bearing,
        mid_lat=(lat[tail] + lat[head]) / 2, mid_lon=(lon[tail] + lon[head]) / 2,
        edge_profile_start=profile_start[owner], edge_profile_points=profile_points[owner],
        profile_elevation_m=along[profile_points > 0].ravel().astype(np.float32),
        profile_position=np.tile(np.array([0.0, 1.0], dtype=np.float32), int((profile_points > 0).sum())),
        edgeless=edgeless,
    )
