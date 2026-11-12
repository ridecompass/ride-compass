"""探索が選んだ経路（`TracedLoop`）を、応答の候補（`EvaluatedRoute`）へ組み立てる。

- **区間表示は探索と同じコスト配列・材料の表から引く。** 二重に計算しない。
- **標高・風は探索フェーズで読んだ材料の中にある。** 経路確定後に外部へ取りに行かない。
"""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import TypeVar, cast

import numpy as np

from app.domain.attributes import ElevationAttribute
from app.domain.leg_costs import LegValues
from app.domain.geo import compass_label
from app.domain.graph import LeanEdge
from app.domain.road_network import elevation_attribute
from app.domain.route_road_classes import SegmentClassReader
from app.domain.route import (
    COST_SECONDS_DECIMALS,
    PenaltyBreakdown,
    RouteFacts,
    merge_penalty_breakdowns,
    ElevationStretch,
    EvaluatedRoute,
    RoadClassStretch,
    RouteSegmentDetail,
    RouteTurn,
    DISTANCE_KM_DECIMALS,
    ELEVATION_M_DECIMALS,
    aggregate_segments_into_bins,
    route_bin_slices,
    steepest_signed_percent,
    along_route_km,
    concat_edge_geometries,
    reverse_elevation_by_edge,
    elevation_gain,
)
from app.domain.route_search import (
    EdgePassage,
    prefers_reverse,
    reverse_leg_assignment,
    route_cost,
    route_passages,
    transition_values_along,
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
    return await asyncio.to_thread(
        lambda: [
            _build_best_candidate(context, t, edges_in_path, start_time)
            for t, edges_in_path in zip(traced, edges_by_candidate)
        ]
    )


@dataclass(frozen=True, slots=True)
class _RowRead:
    """経路の区間のうち、同じ値の組から読む区間。時刻で変わる値（代償の内訳・向かい風）は、探索がその区間に使ったビンの時刻で
    経路上の行だけを合成し直した値（`domain/leg_costs.py: LegCostComposer.values_at_rows`、`indices`と同じ並び）。時刻で
    変わらない値（事実の量・分類の材料）は合成器の列を`rows`で読む。"""

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


@dataclass(frozen=True, slots=True)
class _Traced:
    """周回の1つの向きを、探索と同じ規則でたどったもの（`_trace`）。向きの比べはこの費用だけを読む。"""

    edges: list[LeanEdge]
    path: list[int]
    leg_of_edge: list[int]
    waypoint_offsets: list[int]
    rows: list[int]
    # 経路の遷移の位置（`TurnExpandedStructure.entries_along`）。時刻の待ちと案内する曲がりが読む。
    entries: list[int | None]
    # 遷移ごとの曲がる所の漕ぎ出しの回数（`entries`と同じ並び）。費用と、候補の内訳の軸の秒・止まる回数が読む。
    turn_kickoffs: list[float]
    passages: list[EdgePassage]
    # 経路の費用（`domain/route_search.py: route_cost`）。向きの比べと候補の並べ方が同じ値を読む。
    cost_seconds: float


@dataclass(frozen=True, slots=True)
class _Orientation(_Traced):
    """残した向きと、その区間の値（`_orientation`）。"""

    reads: list[_RowRead]
    # 区間の距離を応答の桁へ丸めた値（km）と、それで切ったビンの範囲（`domain/route.py: route_bin_slices`）。
    distances_km: list[float]
    bin_slices: list[slice]


def _trace(
    context: RoadGraphContext,
    edges_in_path: list[LeanEdge],
    path: list[int],
    leg_of_edge: list[int],
    waypoint_offsets: list[int],
) -> _Traced:
    rows = [slice_row_of(context, index) for index in path]
    entries = context.turn_structure.entries_along(path)
    # 経路を探索と同じ規則でたどった区間ごとの時刻。区間の到達予想と候補の所要時間が同じ時計を使う。
    turn_waits = transition_values_along(context.turn_structure.turn_seconds, entries)
    turn_kickoffs = transition_values_along(context.turn_structure.turn_kickoffs, entries)
    passages = route_passages(context.legs, turn_waits, path, leg_of_edge)
    return _Traced(edges_in_path, path, leg_of_edge, waypoint_offsets, rows, entries, turn_kickoffs, passages,
                   route_cost(passages, turn_waits, turn_kickoffs, context.composer))


def _orientation(context: RoadGraphContext, traced: _Traced) -> _Orientation:
    """残した向きの区間の値を、探索が使ったビンの時刻で読む（向きの比べで負けた向きは読まない）。"""
    reads = _row_reads(context, traced.rows, traced.leg_of_edge, traced.passages)
    rounded_km = [round(edge.distance_m / 1000, DISTANCE_KM_DECIMALS) for edge in traced.edges]
    return _Orientation(
        traced.edges, traced.path, traced.leg_of_edge, traced.waypoint_offsets, traced.rows, traced.entries,
        traced.turn_kickoffs, traced.passages, traced.cost_seconds, reads, rounded_km, route_bin_slices(rounded_km),
    )


def _build_best_candidate(
    context: RoadGraphContext,
    traced: TracedLoop,
    edges_in_path: list[LeanEdge],
    start_time: datetime,
) -> EvaluatedRoute:
    """1候補ぶんの周回を組み立てる。

    同じ周回の逆回りは追加のI/Oなしで評価できるため、両向きの費用から**費用の小さい向きだけ**を
    組み立てる（両方向を別候補として並べない）。逆走は勾配・風で評点が変わるため常に意味がある。
    一方通行Edgeが1つでもあれば成立しないので、その場合は順方向のみ。

    逆に回ると置いた順が崩れる経路・出発地へ戻らない経路（`TracedLoop.reversible`が偽）は逆回りを作らない。
    """
    orient_started = start_timer()
    path: list[int] = traced.data
    chosen = _trace(context, edges_in_path, path, traced.leg_of_edge, traced.waypoint_offsets)
    elevation_by_edge = _elevation_by_edge(context, edges_in_path, path)
    reversed_path = _reverse_traced_edges(edges_in_path, path, context) if traced.reversible else None
    if reversed_path is not None:
        reverse_edges, reverse_path = reversed_path
        reverse = _trace(
            context, reverse_edges, reverse_path, reverse_leg_assignment(traced.leg_of_edge),
            # 逆に回ると、経由地より前の区間は経由地より後の区間になる。
            [len(path) - offset for offset in traced.waypoint_offsets],
        )
        if prefers_reverse(chosen.cost_seconds, reverse.cost_seconds):
            elevation_by_edge = reverse_elevation_by_edge(edges_in_path, reverse_edges, elevation_by_edge)
            chosen = reverse
    orientation = _orientation(context, chosen)
    add_elapsed_ms(context.evaluate_steps_ms, "orient", orient_started)
    return _build_candidate(context, traced, orientation, elevation_by_edge, start_time)

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
) -> EvaluatedRoute:
    # distance_km・bearingは同じ物理経路なので順方向の`traced`のものをそのまま使う。
    edges_in_path = orientation.edges
    passages = orientation.passages
    segments_started = start_timer()
    geometry, edge_point_offsets = concat_edge_geometries(edges_in_path)
    along_km = along_route_km(edge.distance_m / 1000 for edge in edges_in_path)
    segments = _build_segment_details(orientation, along_km, elevation_by_edge, context, start_time)
    elevation_gain_m = elevation_gain(np.array([
        attribute.elevation_gain_m if (attribute := elevation_by_edge.get(edge.edge_id)) is not None else np.nan
        for edge in edges_in_path]))
    turns = _route_turns(context.turn_structure, orientation.entries, edges_in_path, along_km)
    turn_kickoffs = float(sum(orientation.turn_kickoffs))
    facts = _route_facts(orientation, context, elevation_gain_m, turn_kickoffs)
    add_elapsed_ms(context.evaluate_steps_ms, "segments", segments_started)
    bins_started = start_timer()
    # 候補の内訳は丸める前の区間から足す（丸めたビンを足すと、丸めの分が候補の内訳へ積もる）。区間は通った道の分なので、通る道筋で
    # 決まる曲がる所の漕ぎ出しを、その費目を持つ軸の秒として足す。
    turn_penalty = PenaltyBreakdown.model_construct(
        axis_seconds=context.composer.turn_penalty_by_axis(turn_kickoffs), preferred_seconds=0.0, avoided_seconds=0.0)
    penalty = merge_penalty_breakdowns([*(segment.penalty for segment in segments), turn_penalty])
    # 返すsegmentsは集約する。Edge単位のままだとペイロードとフロントの描画費用が嵩む。
    segments = aggregate_segments_into_bins(segments, orientation.bin_slices)
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
        cost_seconds=round(orientation.cost_seconds, COST_SECONDS_DECIMALS),
        penalty=penalty,
        facts=facts,
        # 所要時間＝区間の走行時間＋停止の待ち＋ターンの待ち（最後の区間を抜けた時刻）。
        estimated_duration_seconds=passages[-1].elapsed_seconds + passages[-1].seconds if passages else None,
        missing_travel_data_share=(
            context.composer.missing_travel_data_share(np.asarray(orientation.rows, dtype=np.int64))
            if orientation.rows else None
        ),
        elevation_gain_m=elevation_gain_m,
    )

def _build_segment_details(
    orientation: _Orientation,
    along_km: list[float],
    elevation_by_edge: dict,
    context: RoadGraphContext,
    start_time: datetime,
) -> list[RouteSegmentDetail]:
    """区間ごとの表示値（ビンへ畳む前の、Edge単位の区間）。

    代償の秒は値の組（`_Orientation.reads`）から読む。区間は検証せずに組み、検証はビン
    （`domain/route.py: aggregate_segments_into_bins`）でだけ行う。到達予想時刻は経路を探索と同じ規則でたどった時刻（`passages`）。
    """
    penalties = _segment_penalties(orientation)

    segments = []
    road_classes = SegmentClassReader.of(context.road)
    for index, (edge, row) in enumerate(zip(orientation.edges, orientation.rows)):
        rounded_km = orientation.distances_km[index]
        elevation_attr = elevation_by_edge.get(edge.edge_id)

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
                sustained_gradient_percent=steepest_signed_percent(elevation_attr),
                estimated_arrival_time=arrival_time.isoformat(),
                penalty=penalties[index],
                road_classes={
                    layer: [RoadClassStretch.model_construct(distance_km=rounded_km, value=value)]
                    for layer, value in road_classes.values_at(row).items()
                },
            )
        )

    return segments


def _segment_penalties(orientation: _Orientation) -> list[PenaltyBreakdown]:
    """区間ごとの代償の秒の内訳（通った道の分。`LegValues.penalty_by_axis`）。"""

    def of(read: _RowRead) -> list[PenaltyBreakdown]:
        values = read.values
        axis_lists = {axis_id: seconds.tolist() for axis_id, seconds in values.penalty_by_axis.items()}
        preferred, avoided = values.preferred_seconds.tolist(), values.avoided_seconds.tolist()
        return [
            PenaltyBreakdown.model_construct(
                axis_seconds={axis_id: seconds[position] for axis_id, seconds in axis_lists.items()},
                preferred_seconds=preferred[position], avoided_seconds=avoided[position])
            for position in range(len(read.indices))
        ]

    return _per_segment(orientation.reads, len(orientation.edges), of)


def _route_facts(orientation: _Orientation, context: RoadGraphContext, elevation_gain_m: float | None,
                 turn_kickoffs: float) -> RouteFacts:
    """経路の事実（`domain/leg_costs.py: LegCostComposer.axis_facts`）。軸ごとの秒と向かい風は区間を通る時刻の値で、止まる回数には
    曲がる所の漕ぎ出し`turn_kickoffs`回を足す。"""
    rows = np.asarray(orientation.rows, dtype=np.int64)
    headwind_ms = np.empty(len(rows))
    penalty_by_axis = {axis_id: np.empty(len(rows)) for axis_id in orientation.reads[0].values.penalty_by_axis}
    for read in orientation.reads:
        headwind_ms[read.indices] = read.values.headwind_ms
        for axis_id, seconds in penalty_by_axis.items():
            seconds[read.indices] = read.values.penalty_by_axis[axis_id]
    return RouteFacts(axes=context.composer.axis_facts(rows, penalty_by_axis, elevation_gain_m, headwind_ms, turn_kickoffs))


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
