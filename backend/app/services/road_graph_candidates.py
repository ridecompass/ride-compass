"""探索が選んだ経路（`TracedLoop`）を、応答の候補（`EvaluatedRoute`）へ組み立てる。

- **区間表示は探索と同じコスト配列・スコア行列から引く。** 二重に計算しない。
- **標高・風は探索フェーズで読んだ材料の中にある。** 経路確定後に外部へ取りに行かない。
"""

import asyncio
import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import TypeVar, cast

import numpy as np

from app.domain.attributes import ElevationAttribute
from app.domain.evaluation import DensityAxisColumn, displayed_material_ids
from app.domain.difficulty import axis_contributions, axis_weight_shares
from app.domain.leg_costs import LegValues
from app.domain.gradient import GRADIENT_VALUE_DECIMALS
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.geo import (
    compass_label,
)
from app.domain.graph import LeanEdge
from app.domain.road_network import elevation_attribute
from app.domain.route_road_classes import SegmentClassReader
from app.domain.route import (
    DensityScoreInput,
    ElevationStretch,
    EvaluatedRoute,
    RoadClassStretch,
    RouteSegmentDetail,
    RouteTurn,
    SegmentDifficulty,
    DISTANCE_KM_DECIMALS,
    ELEVATION_M_DECIMALS,
    aggregate_segments_into_bins,
    route_bin_slices,
    route_bins,
    along_route_km,
    concat_edge_geometries,
    merge_material_category_shares,
    reverse_elevation_by_edge,
    route_axis_raw_values,
    route_elevation_gain,
)
from app.domain.route_search import (
    EdgePassage,
    prefers_reverse,
    reverse_leg_assignment,
    route_passages,
    turn_waits_along,
)
from app.domain.stopwatch import add_elapsed_ms, start_timer
from app.domain.turn_structure import TurnExpandedStructure, TurnKind, turns_along
from app.services.graph_service import GraphService
from app.domain.loop_routing import TracedLoop
from app.services.road_graph_context import (
    RoadGraphContext,
    slice_row_of,
    network_row_of,
    lean_edge,
    reverse_edge_index,
)


async def evaluate_routes(
    graph_service: GraphService, context: RoadGraphContext, traced: list[TracedLoop], start_time: datetime
) -> list[EvaluatedRoute]:
    # 実ジオメトリは距離フィルタを通った候補ぶんだけを、全候補まとめて1回で取り直す
    # （棄却済み候補ぶんは問い合わせない）。引けない区間があれば落とす——探索が通った
    # 区間の実体がDBに無いということで、線の欠けた経路を配るより落ちる方がよい。
    hydrate_started = start_timer()
    topology = {
        index: lean_edge(context, index)
        for index in dict.fromkeys(index for t in traced for index in t.data)
    }
    hydrated = await graph_service.get_edges_with_geometry(list(topology.values()))
    edges_by_candidate: list[list[LeanEdge]] = [
        [hydrated[topology[index].edge_id] for index in t.data] for t in traced
    ]
    add_elapsed_ms(context.evaluate_steps_ms, "hydrate", hydrate_started)
    active_material_ids = displayed_material_ids(context.composer.weights, context.composer.axis_definitions)
    return await asyncio.to_thread(
        lambda: [
            _build_best_candidate(context, t, edges_in_path, start_time, active_material_ids)
            for t, edges_in_path in zip(traced, edges_by_candidate)
        ]
    )


@dataclass(frozen=True, slots=True)
class _RowRead:
    """経路の区間のうち、同じ値の組から読む区間。時刻で変わる値（難易度・軸・材料）は、探索がその区間に使ったビンの時刻で
    経路上の行だけを合成し直した値（`domain/leg_costs.py: LegCostComposer.values_at_rows`、`indices`と同じ並び）。時刻で
    変わらない値（密度の軸の横軸・生値・分類の材料）は合成器の列を`rows`で読む。"""

    values: LegValues
    # 経路の中の区間の添字と、同じ並びの切り出した区間の順の行。
    indices: list[int]
    rows: np.ndarray


_T = TypeVar("_T")


def _row_reads(
    context: RoadGraphContext, rows: list[int], leg_of_edge: list[int], passages: list[EdgePassage]
) -> list[_RowRead]:
    """経路の区間を、読む値の組ごとにまとめる。同じレグ・同じビンの区間はまとめて1回で合成し直す。"""
    groups: dict[tuple[int, int], list[int]] = {}
    for index, (leg_index, passage) in enumerate(zip(leg_of_edge, passages)):
        groups.setdefault((leg_index, passage.time_bin), []).append(index)
    reads = []
    for (leg_index, time_bin), indices in groups.items():
        group_rows = np.array([rows[i] for i in indices], dtype=np.int64)
        values = context.composer.values_at_rows(group_rows, context.legs[leg_index].bin_times[time_bin])
        reads.append(_RowRead(values, indices, group_rows))
    return reads


def _per_segment(reads: list[_RowRead], count: int, values_of: Callable[[_RowRead], list[_T]]) -> list[_T]:
    """読む値の組ごとに求めた区間の値（`values_of`。`read.indices`と同じ並び）を、経路の区間の並びへ配る。"""
    placed: list[_T | None] = [None] * count
    for read in reads:
        for index, value in zip(read.indices, values_of(read), strict=True):
            placed[index] = value
    assert all(value is not None for value in placed), "どの値の組にも入らない区間がある"
    return cast(list[_T], placed)


def _present_rows(columns: Mapping[str, list], count: int) -> list[dict]:
    """鍵→`count`区間ぶんの値の列から、区間ごとの、値のある鍵だけの辞書（NaN・Noneは値が無い。NaNは自分と等しくない）。"""
    keys = list(columns)
    rows = zip(*columns.values()) if keys else [()] * count
    return [{key: value for key, value in zip(keys, row) if value is not None and value == value} for row in rows]


def _segment_difficulties(
    reads: list[_RowRead], density_axes: Mapping[str, DensityAxisColumn], distances_km: list[float], rounded_km: list[float]
) -> list[SegmentDifficulty]:
    """区間ごとの難しさの値（合成の難しさ・軸の得点・寄与度・密度の軸の横軸の値）。`distances_km`は丸めない区間の距離、
    `rounded_km`は応答の桁へ丸めた距離（`_Orientation.distances_km`）。

    探索が使ったビンの時刻で合成し直した値（`_RowRead.values`）を読み、探索コストと表示を一致させる。
    """
    def of(read: _RowRead) -> list[SegmentDifficulty]:
        values, count = read.values, len(read.indices)
        shares = axis_weight_shares(values.axis_arrays, values.weights, values.weight_sums)
        score_lists = {axis_id: score.tolist() for axis_id, score in values.axis_arrays.items()}
        contributions = axis_contributions(score_lists, shares)
        composite = values.difficulty_array.tolist()
        # 密度の軸は、ビンと候補で得点を作り直すために横軸の値を載せる（点数と同じ区間が欠損になる）。
        density = {axis_id: column.inputs[read.rows].tolist() for axis_id, column in density_axes.items()}
        difficulties = []
        for position, (index, scores, inputs) in enumerate(
            zip(read.indices, _present_rows(score_lists, count), _present_rows(density, count))
        ):
            distance_km = distances_km[index]
            difficulties.append(SegmentDifficulty(
                distance_km=rounded_km[index],
                difficulty=None if math.isnan(composite[position]) else composite[position],
                axis_difficulties=scores,
                axis_contributions=contributions[position],
                density_inputs={
                    axis_id: DensityScoreInput(
                        value=value, distance_km=distance_km, weight_share=shares[position].get(axis_id),
                        shape=density_axes[axis_id].shape,
                    )
                    for axis_id, value in inputs.items()
                },
            ))
        return difficulties

    return _per_segment(reads, len(distances_km), of)


@dataclass(frozen=True, slots=True)
class _Orientation:
    """周回の1つの向き。向きを選ぶために求めた値を、残した向きの組み立てがそのまま使う。"""

    edges: list[LeanEdge]
    path: list[int]
    leg_of_edge: list[int]
    waypoint_offsets: list[int]
    rows: list[int]
    # 経路の遷移の位置（`TurnExpandedStructure.entries_along`）。時刻の待ちと案内する曲がりが読む。
    entries: list[int | None]
    passages: list[EdgePassage]
    reads: list[_RowRead]
    # 区間の距離を応答の桁へ丸めた値（km）。区間の難しさと区間の器が同じ値を持ち、ビンの切り方が揃う。
    distances_km: list[float]
    # ビンの範囲（`domain/route.py: route_bin_slices`）と、ビンの難しさ（`domain/route.py: route_bins`）。向きの比べと
    # ビンの組み立てが同じ値を読む。
    bin_slices: list[slice]
    bins: list[SegmentDifficulty]


def _orientation(
    context: RoadGraphContext,
    edges_in_path: list[LeanEdge],
    path: list[int],
    leg_of_edge: list[int],
    waypoint_offsets: list[int],
) -> _Orientation:
    rows = [slice_row_of(context, index) for index in path]
    entries = context.turn_structure.entries_along(path)
    # 経路を探索と同じ規則でたどった区間ごとの時刻。区間の到達予想と候補の所要時間が同じ時計を使う。
    passages = route_passages(
        context.legs, turn_waits_along(context.turn_structure, entries), path,
        [edge.distance_m for edge in edges_in_path], leg_of_edge, context.composer.speed_kmh,
    )
    reads = _row_reads(context, rows, leg_of_edge, passages)
    distances_km = [edge.distance_m / 1000 for edge in edges_in_path]
    rounded_km = [round(distance_km, DISTANCE_KM_DECIMALS) for distance_km in distances_km]
    bin_slices = route_bin_slices(rounded_km)
    bins = route_bins(_segment_difficulties(reads, context.composer.density_axes, distances_km, rounded_km), bin_slices)
    return _Orientation(
        edges_in_path, path, leg_of_edge, waypoint_offsets, rows, entries, passages, reads, rounded_km, bin_slices, bins
    )


def _build_best_candidate(
    context: RoadGraphContext,
    traced: TracedLoop,
    edges_in_path: list[LeanEdge],
    start_time: datetime,
    active_material_ids: set[str],
) -> EvaluatedRoute:
    """1候補ぶんの周回を組み立てる。

    同じ周回の逆回りは追加のI/Oなしで評価できるため、両向きのビンの難しさから**難易度の小さい向きだけ**を
    組み立てる（両方向を別候補として並べない）。逆走は勾配・風で評点が変わるため常に意味がある。
    一方通行Edgeが1つでもあれば成立しないので、その場合は順方向のみ。

    逆に回ると置いた順が崩れる経路・出発地へ戻らない経路（`TracedLoop.reversible`が偽）は逆回りを作らない。
    """
    orient_started = start_timer()
    path: list[int] = traced.data
    chosen = _orientation(context, edges_in_path, path, traced.leg_of_edge, traced.waypoint_offsets)
    elevation_by_edge = _elevation_by_edge(context, edges_in_path, path)
    reversed_path = _reverse_traced_edges(edges_in_path, path, context) if traced.reversible else None
    if reversed_path is not None:
        reverse_edges, reverse_path = reversed_path
        reverse = _orientation(
            context, reverse_edges, reverse_path, reverse_leg_assignment(traced.leg_of_edge),
            # 逆に回ると、経由地より前の区間は経由地より後の区間になる。
            [len(path) - offset for offset in traced.waypoint_offsets],
        )
        if prefers_reverse(chosen.bins, reverse.bins):
            elevation_by_edge = reverse_elevation_by_edge(edges_in_path, reverse_edges, elevation_by_edge)
            chosen = reverse
    add_elapsed_ms(context.evaluate_steps_ms, "orient", orient_started)
    return _build_candidate(context, traced, chosen, elevation_by_edge, start_time, active_material_ids)

def _elevation_by_edge(
    context: "RoadGraphContext", edges_in_path: list[LeanEdge], path: list[int]
) -> dict[str, ElevationAttribute]:
    """経路の区間ぶんの標高属性。探索フェーズで読んだ材料がそのまま持っている。

    取り込んだ範囲の全区間ぶんを派生バッチが埋めるため、ここで外部へ取りに行く経路は
    無い（欠けているのは標高タイルが覆っていない区間だけで、そこは値なしのまま）。
    """
    found = {}
    for edge, index in zip(edges_in_path, path, strict=True):
        attribute = elevation_attribute(context.road.network, network_row_of(context, index), edge.edge_id)
        if attribute is not None:
            found[edge.edge_id] = attribute
    return found

def _build_candidate(
    context: RoadGraphContext,
    traced: TracedLoop,
    orientation: _Orientation,
    elevation_by_edge: dict[str, ElevationAttribute],
    start_time: datetime,
    active_material_ids: set[str],
) -> EvaluatedRoute:
    # distance_km・bearingは同じ物理経路なので順方向の`traced`のものをそのまま使う。
    edges_in_path = orientation.edges
    passages = orientation.passages
    segments_started = start_timer()
    geometry, edge_point_offsets = concat_edge_geometries(edges_in_path)
    along_km = along_route_km(edge.distance_m / 1000 for edge in edges_in_path)
    segments, segment_categories, segment_raw_values = _build_segment_details(
        orientation, along_km, elevation_by_edge, context, start_time, active_material_ids,
    )
    turns = _route_turns(context.turn_structure, orientation.entries, edges_in_path, along_km)
    add_elapsed_ms(context.evaluate_steps_ms, "segments", segments_started)
    bins_started = start_timer()
    # categorical材料の延長割合は**集約より前に**Edge単位の値から畳む。集約後に
    # 計算すると、ビンの代表値を1つ選ぶ形になり割合がビンの粒度へ量子化される。
    material_category_shares = merge_material_category_shares(
        zip((segment.distance_km for segment in segments), segment_categories)
    )
    axis_raw_values = route_axis_raw_values(
        list(zip((segment.distance_km for segment in segments), segment_raw_values)), orientation.bin_slices
    )
    # 返すsegmentsは集約する。Edge単位のままだとペイロードとフロントの描画費用が嵩む。
    segments = aggregate_segments_into_bins(segments, orientation.bins, orientation.bin_slices)
    add_elapsed_ms(context.evaluate_steps_ms, "bins", bins_started)

    return EvaluatedRoute(
        # 方位を持たない経路の名前は、種類と一緒に`route_generator.py: _label`が付ける。
        direction_label=compass_label(traced.bearing) if traced.bearing is not None else "",
        distance_km=traced.distance_km,
        geometry=geometry,
        edge_ids=[edge.edge_id for edge in edges_in_path],
        edge_point_offsets=edge_point_offsets,
        node_ids=(
            [edges_in_path[0].from_node_id, *(edge.to_node_id for edge in edges_in_path)]
            if edges_in_path else []
        ),
        turns=turns,
        waypoint_distances_km=[along_km[offset] for offset in orientation.waypoint_offsets],
        segments=segments,
        material_category_shares=material_category_shares,
        axis_raw_values=axis_raw_values,
        # 所要時間＝区間の走行時間＋停止の待ち＋ターンの待ち（最後の区間を抜けた時刻）。
        estimated_duration_seconds=passages[-1].elapsed_seconds + passages[-1].seconds if passages else None,
        wind_unavailable=context.composer.wind_unavailable,
        missing_travel_data_share=(
            context.composer.missing_travel_data_share(np.asarray(orientation.rows, dtype=np.int64))
            if orientation.rows else None
        ),
        elevation_gain_m=route_elevation_gain(edges_in_path, elevation_by_edge),
    )

def _build_segment_details(
    orientation: _Orientation,
    along_km: list[float],
    elevation_by_edge: dict,
    context: RoadGraphContext,
    start_time: datetime,
    active_material_ids: set[str],
) -> tuple[list[RouteSegmentDetail], list[dict[str, str]], list[dict[str, float]]]:
    """区間ごとの表示値と、区間ごとのcategorical材料の値（材料id→値）・軸の生値（axis_id→値）を組み立てる。
    categorical材料の値は平均できず区間の器（ビンへ畳まれる）に載せられないため、軸の生値は画面が
    候補全体の値しか読まないため、どちらも候補全体へ畳む`_build_candidate`へ並びのまま渡す。

    材料値は同じ値の組（`_Orientation.reads`）から読む。難しさの値は区間に載せず、ビンが向きを選ぶときに畳んだもの
    （`_Orientation.bins`）を載せる。区間は検証せずに組み、検証はビン（`domain/route.py: aggregate_segments_into_bins`）でだけ行う。
    到達予想時刻は経路を探索と同じ規則でたどった時刻（`passages`）。
    """
    count = len(orientation.edges)

    def materials_of(read: _RowRead) -> list[dict[str, float]]:
        columns = {
            material_id: array.astype(float).tolist()
            for material_id in active_material_ids
            if (array := read.values.material_arrays.get(material_id)) is not None
        }
        return _present_rows(columns, len(read.indices))

    def categories_of(read: _RowRead) -> list[dict[str, str]]:
        columns = {
            material_id: [column.vocab[code] for code in column.codes[read.rows].tolist()]
            for material_id, column in context.composer.categorical_material_arrays.items()
            if material_id in active_material_ids
        }
        return _present_rows(columns, len(read.indices))

    def raw_values_of(read: _RowRead) -> list[dict[str, float]]:
        # 折れ点を通す前の生値。静的スコア行列が持つ列をそのまま読む（動的材料を参照する軸は行列側で除外済み）。
        columns = {axis_id: arr[read.rows].tolist() for axis_id, arr in context.composer.axis_raw_arrays.items()}
        return _present_rows(columns, len(read.indices))

    material_values = _per_segment(orientation.reads, count, materials_of)
    segment_categories = _per_segment(orientation.reads, count, categories_of)
    segment_raw_values = _per_segment(orientation.reads, count, raw_values_of)

    segments = []
    road_classes = SegmentClassReader.of(context.road)
    for index, (edge, row) in enumerate(zip(orientation.edges, orientation.rows)):
        rounded_km = orientation.distances_km[index]
        elevation_attr = elevation_by_edge.get(edge.edge_id)

        gradient_percent = elevation_attr.average_grade if elevation_attr else None
        # 勾配は地図の配信と同じ桁へ丸めた値で、材料の列の値を上書きする。
        if GRADIENT_PERCENT in active_material_ids and gradient_percent is not None:
            material_values[index] = material_values[index] | {
                GRADIENT_PERCENT: round(gradient_percent, GRADIENT_VALUE_DECIMALS)
            }

        arrival_time = start_time + timedelta(seconds=orientation.passages[index].elapsed_seconds)

        start_lat, start_lon = edge.geometry[0]
        end_lat, end_lon = edge.geometry[-1]
        # 区間の道なり形状はEdgeの形状点列そのもの（追加取得なし）。2点未満のEdgeは
        # 形状にならないためNone（フロントは始点・終点の直線で代替描画する）。
        segment_coordinates = [[lon, lat] for lat, lon in edge.geometry]

        segments.append(
            RouteSegmentDetail.model_construct(
                geometry=(
                    {"type": "LineString", "coordinates": segment_coordinates}
                    if len(segment_coordinates) >= 2
                    else None
                ),
                start_latitude=start_lat,
                start_longitude=start_lon,
                end_latitude=end_lat,
                end_longitude=end_lon,
                cumulative_distance_km=along_km[index],
                distance_km=rounded_km,
                edge_start=index,
                edge_end=index + 1,
                # 標高の表は単精度で持つので、表に入れた桁へ丸め直す。
                elevations=[
                    ElevationStretch.model_construct(
                        distance_km=rounded_km,
                        start_elevation_m=(
                            round(elevation_attr.start_elevation_m, ELEVATION_M_DECIMALS)
                            if elevation_attr
                            else None
                        ),
                        end_elevation_m=(
                            round(elevation_attr.end_elevation_m, ELEVATION_M_DECIMALS) if elevation_attr else None
                        ),
                    )
                ],
                estimated_arrival_time=arrival_time.isoformat(),
                material_values=material_values[index],
                road_classes={
                    layer: [RoadClassStretch.model_construct(distance_km=rounded_km, value=value)]
                    for layer, value in road_classes.values_at(row).items()
                },
            )
        )

    return segments, segment_categories, segment_raw_values


_TURN_DIRECTION = {TurnKind.LEFT: "left", TurnKind.RIGHT: "right", TurnKind.UTURN: "uturn"}


def _route_turns(
    structure: TurnExpandedStructure, entries: list[int | None], edges_in_path: list[LeanEdge], along_km: list[float]
) -> list[RouteTurn]:
    """経路が分かれ道で曲がる所を、応答の形にする。距離は曲がった先の区間の始まりの道のり（`along_km`）、地点はその区間の始点。"""
    turns = []
    for turn in turns_along(structure, entries):
        latitude, longitude = edges_in_path[turn.index].geometry[0]
        turns.append(RouteTurn(
            distance_km=along_km[turn.index],
            direction=_TURN_DIRECTION[turn.kind],
            latitude=latitude,
            longitude=longitude,
        ))
    return turns


def _reverse_traced_edges(
    edges_in_path: list[LeanEdge], path: list[int], context: RoadGraphContext
) -> tuple[list[LeanEdge], list[int]] | None:
    """順方向の経路（起点→...→起点）を逆順に辿った場合の、対応する逆方向の区間の列と
    その番号列を構築する。経路中に一方通行（逆方向の区間が存在しない）区間が1つでもあれば
    物理的に逆走不可能なため`None`を返す。

    `geometry`だけは逆方向の区間自身（形を持たない）からではなく、順方向で取得済みの
    ものを反転して使う——同じ物理区間を逆順に辿るだけなので、取り直す必要が無い。
    進行方向に依存しない値も**逆方向の区間自身から**引く。
    """
    reverse_edges: list[LeanEdge] = []
    reverse_path: list[int] = []
    for edge, index in zip(reversed(edges_in_path), reversed(path), strict=True):
        reverse_index = reverse_edge_index(context, index)
        if reverse_index is None:
            return None
        topology = lean_edge(context, reverse_index)
        reverse_edges.append(replace(topology, geometry=list(reversed(edge.geometry))))
        reverse_path.append(reverse_index)
    return reverse_edges, reverse_path
