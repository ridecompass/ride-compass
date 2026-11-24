"""道の事実から、取込範囲全体の道路網の配列（`domain/road_network.py: RoadNetwork`）を組む。

道の事実から安く導ける値は、ここで取込範囲全体について1回だけ求める: 区間と頂点の階級、端のそばの向きの欠け、
形の外接矩形、道の向き、断面から決まる値（要約・点の間・標高の無い長さ・気圧を出す標高。勾配の規則は
`domain/elevation_profile.py: interval_grade`の1つ）、断面から決まる材料（出どころが`profile`の勾配と登りの量。読み出した
行列の列は値を持たず、ここで埋める）、数値の材料の平均、道1本の材料。ルート生成と地図（レンズ・区分の層・押した道の小窓）と派生データベースの書き出しは、
ここで出した値を読み、要求の中で求め直さない。

**道1本の材料は、区間の値を1つの集め方で道ごとに1回集める**（区間ごとに一番若い行の値を、道の向きに走った値
（`along_way`）にして、区間の長さで重みを付けて集める）: 数値は値のある区間の平均、真偽と分類は区間の長さの和が一番長い値
（同じ長さなら小さい値。真偽は1.0か0.0）。値の無い区間は数えず、どの区間にも値が無ければ値を持たない。
"""

from dataclasses import dataclass
from typing import Any

import numpy as np

from app.domain.elevation_profile import (
    SUMMARY_COLUMNS,
    ElevationProfiles,
    grade_distribution,
    profile_spans,
    profile_summaries,
)
from app.domain.geo import bearings_between
from app.domain.material_catalog import ELEVATION_GAIN_PER_KM, GRADIENT_PERCENT, MATERIAL_CATALOG
from app.domain.road_network import RoadNetwork
from app.domain.search_graph import EDGE_VALUE_DTYPE, range_positions, run_starts
from app.domain.traffic_regulation import SLOT_FIELDS, active_kinds, invariant_slots, pedestrian_road_codes


@dataclass(frozen=True)
class NetworkRegulations:
    """区間に当たった交通規制（`infrastructure/road_graph_repository.py: get_network_regulations`）。規制は0始まりの番号で、
    当たりは区間の番号順、組は規制の番号順。"""

    regulation_count: int
    hit_way: np.ndarray
    hit_segment: np.ndarray
    hit_regulation: np.ndarray
    slot_regulation: np.ndarray
    slot_values: np.ndarray  # (組, `domain/traffic_regulation.py: SLOT_FIELDS`)

    @classmethod
    def none(cls) -> "NetworkRegulations":
        empty = np.zeros(0, dtype=np.int64)
        return cls(0, empty, empty, empty, empty, np.zeros((0, len(SLOT_FIELDS)), dtype=np.int16))


def regulation_arrays(edge_way_id: np.ndarray, edge_segment: np.ndarray, regulations: NetworkRegulations,
                      ) -> tuple[dict[str, Any], np.ndarray]:
    """`RoadNetwork`の規制の欄と、材料`pedestrian_road`の列の番号（`PEDESTRIAN_ROAD_LABELS`の並びの語彙。時刻で変わらない組だけで
    決め、自転車も対象の規制と除外の規制が両方効く区間は、自転車も禁止）。区間の行は道・区間の番号順で、同じ区間の両向きの行が
    同じ規制を持つ。"""
    # 区間の番号は smallint（2**15 未満）なので、道の番号と1つの数に詰めて比べる。
    row_key = np.asarray(edge_way_id, dtype=np.int64) * 65536 + np.asarray(edge_segment, dtype=np.int64)
    hit_key = regulations.hit_way * 65536 + regulations.hit_segment
    low, high = np.searchsorted(row_key, hit_key, "left"), np.searchsorted(row_key, hit_key, "right")
    per_hit = high - low
    row = range_positions(low, per_hit)
    order = np.argsort(row, kind="stable")
    regulation = np.repeat(regulations.hit_regulation, per_hit)[order]
    count = np.bincount(row[order], minlength=len(row_key)).astype(np.int16)
    slot_count = np.bincount(regulations.slot_regulation, minlength=regulations.regulation_count).astype(np.int16)
    fields = {
        "edge_regulation_start": np.cumsum(count, dtype=np.int64) - count, "edge_regulation_count": count,
        "regulation_index": regulation.astype(np.int32),
        "regulation_slot_start": np.cumsum(slot_count, dtype=np.int64) - slot_count, "regulation_slot_count": slot_count,
        "regulation_slot_values": regulations.slot_values,
    }
    bicycle, excepted = active_kinds(np.arange(len(row_key)), fields["edge_regulation_start"], count, regulation,
                                     fields["regulation_slot_start"], slot_count, regulations.slot_values,
                                     invariant_slots(regulations.slot_values), slotless_active=True)
    return fields, pedestrian_road_codes(bicycle, excepted)


def build_road_network(
    *, node_lat: np.ndarray, node_lon: np.ndarray, edge_way_id: np.ndarray, edge_segment: np.ndarray,
    edge_forward: np.ndarray, edge_from: np.ndarray, edge_to: np.ndarray, edge_rank: np.ndarray,
    edge_start_bearing_deg: np.ndarray, edge_end_bearing_deg: np.ndarray, edge_shape_start: np.ndarray,
    edge_shape_points: np.ndarray, shape_lon: np.ndarray, shape_lat: np.ndarray, numeric_ids: tuple[str, ...],
    numeric_values: np.ndarray, categorical_codes: np.ndarray, distance_m: np.ndarray, edge_profile_start: np.ndarray,
    edge_profile_points: np.ndarray, profile_elevation_m: np.ndarray, profile_position: np.ndarray,
    max_grade: float, steepest_min_interval_m: float, **facts: Any,
) -> RoadNetwork:
    """道の事実から`RoadNetwork`を組む。区間は有向の行（`RoadNetwork`の行順）で、端のそばの向きは形から決まらない区間がNaN。
    形と断面の点は、区間ごとに道の順方向に1回だけ、区間の行の順に隙間なく並べ、両向きの行が同じ点を指す。材料の行列`numeric_values`の
    断面から決まる列は、渡した行列の中で埋める。`facts`はそのまま写す`RoadNetwork`の欄。"""
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
                                      distance[first_of_edge], max_grade)
    spans = profile_spans(ElevationProfiles(profile_start, profile_points, np.asarray(edge_forward, dtype=bool),
                                            elevation, position, distribution, max_grade), distance)
    summaries = dict(zip(SUMMARY_COLUMNS, profile_summaries(
        profile_start, profile_points.astype(np.int64), np.asarray(edge_forward, dtype=np.bool_), elevation, position,
        distance, steepest_min_interval_m, max_grade).T, strict=True))

    # 材料の行列は取込範囲全体で道路網の配列の大半を占めるので、写さずに断面から決まる列だけを埋める。
    values = np.asarray(numeric_values, dtype=EDGE_VALUE_DTYPE)
    gain_per_km = per_km(summaries["elevation_gain_m"], distance)
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
        categorical_codes=categorical_codes,
        **_way_values(edge_way_id, first_of_edge, np.asarray(edge_forward, dtype=bool), distance, numeric_ids, values,
                      summaries["elevation_loss_m"], categorical_codes),
        distance_m=distance, edge_way_bearing_deg=_way_bearings(node_lat, node_lon, edge_way_id, edge_forward, edge_from,
                                                          edge_to),
        **summaries, edge_profile_start=profile_start, edge_profile_points=profile_points,
        profile_elevation_m=elevation, profile_position=position,
        edge_span_start=spans.start, edge_span_count=spans.count, edge_span_positioned=spans.positioned,
        span_length_m=spans.length_m, span_grade=spans.grade,
        unknown_elevation_m=spans.unknown_m, mean_elevation_m=spans.mean_elevation_m,
        **facts,
    )


def filled_bearings(bearing_deg: np.ndarray, node_lat: np.ndarray, node_lon: np.ndarray, edge_from: np.ndarray,
                    edge_to: np.ndarray) -> np.ndarray:
    """区間の端のそばの向き。形から決まらない（NaNの）区間は、始点の頂点から終点の頂点を見た向きで埋める。倍精度の配列を
    渡すと、写さずにその中で埋める。"""
    bearing = np.asarray(bearing_deg, dtype=np.float64)
    missing = np.flatnonzero(np.isnan(bearing))
    tail, head = edge_from[missing], edge_to[missing]
    bearing[missing] = bearings_between(node_lat[tail], node_lon[tail], node_lat[head], node_lon[head])
    return bearing


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


def per_km(amount: np.ndarray, distance_m: np.ndarray) -> np.ndarray:
    """区間の量`amount`の、区間の長さ1kmあたり（長さ0の区間はNaN）。"""
    distance = np.asarray(distance_m, dtype=np.float64)
    return np.divide(amount, distance / 1000.0, out=np.full(len(distance), np.nan), where=distance > 0)


def along_way(material_id: str, values: np.ndarray, forward: np.ndarray, elevation_loss_m: np.ndarray,
              distance_m: np.ndarray) -> np.ndarray:
    """有向の行ごとの数値の材料`material_id`の値`values`（行の向きに走った値）を、道の向き（形の始点から終点）に走った値にする。
    向きで値の変わる材料は、断面から決まる2つだけ: 逆向きの行は、勾配の符号を返し、登りの量はその行の下りの量
    （`elevation_loss_m`。道の向きに走ったときの登り）を1kmあたりにしたものにする。"""
    if material_id == GRADIENT_PERCENT:
        return np.where(forward, values, -values)
    if material_id == ELEVATION_GAIN_PER_KM:
        return np.where(forward, values, per_km(elevation_loss_m, distance_m))
    return values


def _way_values(edge_way_id: np.ndarray, first_of_edge: np.ndarray, edge_forward: np.ndarray, distance_m: np.ndarray,
                numeric_ids: tuple[str, ...], numeric_values: np.ndarray, elevation_loss_m: np.ndarray,
                categorical_codes: np.ndarray) -> dict[str, Any]:
    """道1本の値の欄（`RoadNetwork`の`way_*`。道の番号の昇順）。区間ごとに一番若い行の、道の向きに走った値を集める。"""
    edges = np.flatnonzero(first_of_edge)
    owner_first = run_starts(edge_way_id[edges])
    owner = np.cumsum(owner_first) - 1
    count = int(owner_first.sum())
    length = distance_m[edges]
    numeric = np.full((count, numeric_values.shape[1]), np.nan, dtype=EDGE_VALUE_DTYPE)
    for column, material_id in enumerate(numeric_ids):
        values = along_way(material_id, numeric_values[edges, column], edge_forward[edges], elevation_loss_m[edges], length)
        known = ~np.isnan(values)
        weight = np.bincount(owner[known], weights=length[known], minlength=count)
        if (spec := MATERIAL_CATALOG.get(material_id)) is not None and spec.dtype == "boolean":
            # 1.0の区間の長さの和が0.0の区間の長さの和より長ければ1.0（同じなら小さい値の0.0）。
            true_length = np.bincount(owner[known], weights=length[known] * (values[known] == 1.0), minlength=count)
            gathered = (2 * true_length > weight).astype(np.float64)
        else:
            # 重みの無い（空の）bincount は整数で返るので、浮動小数にしてから割る。
            gathered = np.bincount(owner[known], weights=values[known] * length[known], minlength=count).astype(np.float64)
            np.divide(gathered, weight, out=gathered, where=weight > 0)
        numeric[:, column] = np.where(weight > 0, gathered, np.nan)
    codes = np.zeros((count, np.shape(categorical_codes)[1]), dtype=np.int16)
    for column in range(codes.shape[1]):
        values = np.asarray(categorical_codes[edges, column], dtype=np.int64)
        known = values != 0
        # 道と値の組ごとの長さの和を、道ごとに長い順に並べ、道ごとの先頭（一番長い値）を採る。
        pairs, inverse = np.unique(owner[known] * 2**16 + values[known], return_inverse=True)
        sums = np.bincount(inverse, weights=length[known])
        longest = np.lexsort((-sums, pairs // 2**16))
        longest = longest[run_starts(pairs[longest] // 2**16)]
        codes[pairs[longest] // 2**16, column] = pairs[longest] % 2**16
    return {"way_osm_id": np.asarray(edge_way_id[edges][owner_first], dtype=np.int64), "way_numeric_values": numeric,
            "way_categorical_codes": codes}

def _way_bearings(node_lat: np.ndarray, node_lon: np.ndarray, way: np.ndarray, forward: np.ndarray,
                  edge_from: np.ndarray, edge_to: np.ndarray) -> np.ndarray:
    """区間の行ごとの、その道の順方向の始点（一番若い区間の始まり）から終点（一番後の区間の終わり）を見た方位。"""
    first_of_way = run_starts(way)
    first = np.flatnonzero(first_of_way)
    last = np.r_[first[1:], len(way)][:len(first)] - 1
    tail = np.where(forward[first], edge_from[first], edge_to[first])
    head = np.where(forward[last], edge_to[last], edge_from[last])
    return bearings_between(node_lat[tail], node_lon[tail], node_lat[head], node_lon[head])[np.cumsum(first_of_way) - 1]
