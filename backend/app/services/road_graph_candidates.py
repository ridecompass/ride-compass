"""探索が選んだ経路（`TracedLoop`）を、応答の候補（`EvaluatedRoute`）へ組み立てる。

- **区間表示は探索と同じコスト配列・スコア行列から引く。** 二重に計算しない。
- **標高・風は探索フェーズで読んだ材料の中にある。** 経路確定後に外部へ取りに行かない。
"""

import asyncio
import math
from dataclasses import dataclass, replace
from datetime import datetime, timedelta

import numpy as np

from app.domain.attributes import ElevationAttribute
from app.domain.evaluation import (
    displayed_material_ids,
)
from app.domain.difficulty import axis_contributions_at_rows, axis_weight_shares_at_rows
from app.domain.leg_costs import LegCostArrays, RowValues
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
    # 表示する材料は共有の軸定義（`domain/axis_definitions.py: AXIS_DEFINITIONS`）から決まるので、
    # 軸の差し替えと同じイベントループの上で1回だけ決め、スレッドの先では読ませない。
    active_material_ids = displayed_material_ids(context.composer.weights)
    return await asyncio.to_thread(
        lambda: [
            _build_best_candidate(context, t, edges_in_path, start_time, active_material_ids)
            for t, edges_in_path in zip(traced, edges_by_candidate)
        ]
    )


@dataclass(frozen=True, slots=True)
class _RowRead:
    """経路の区間のうち、同じ値の組から読む区間。時刻で変わる値（難易度・軸・材料）は、探索がその区間に使った
    ビンの値で、ビンが1本のレグはレグの配列、2本以上のレグは経路上の行だけをそのビンの時刻で合成し直した値
    （`LegCostArrays.bin_start_hours`参照）。時刻で変わらない値（密度の軸の横軸・生値・分類の材料）はレグの配列から読む。"""

    values: LegCostArrays | RowValues
    leg: LegCostArrays
    # 経路の中の区間の添字と、同じ並びの`values`の行・切り出した区間の順の行。
    indices: list[int]
    value_rows: np.ndarray
    rows: np.ndarray


def _row_reads(
    context: RoadGraphContext, rows: list[int], leg_of_edge: list[int], passages: list[EdgePassage]
) -> list[_RowRead]:
    """経路の区間を、読む値の組ごとにまとめる。同じレグ・同じビンの区間はまとめて1回で合成し直す。"""
    groups: dict[tuple[int, int | None], list[int]] = {}
    for index, (leg_index, passage) in enumerate(zip(leg_of_edge, passages)):
        timed = len(context.legs[leg_index].bin_start_hours) > 1
        groups.setdefault((leg_index, passage.time_bin if timed else None), []).append(index)
    reads = []
    for (leg_index, time_bin), indices in groups.items():
        leg = context.legs[leg_index]
        group_rows = np.array([rows[i] for i in indices], dtype=np.int64)
        if time_bin is None:
            reads.append(_RowRead(leg, leg, indices, group_rows, group_rows))
            continue
        hours = np.full(len(group_rows), leg.bin_start_hours[time_bin])
        values = context.composer.values_at_rows(group_rows, hours)
        reads.append(_RowRead(values, leg, indices, np.arange(len(group_rows)), group_rows))
    return reads


def _segment_difficulties(reads: list[_RowRead], distances_km: list[float]) -> list[SegmentDifficulty]:
    """区間ごとの難しさの値（合成の難しさ・軸の得点・寄与度・密度の軸の横軸の値）。

    探索が使った合成済みの配列（`context.legs`、区間の番号から行を引く）からそのまま読み、探索コストと表示を一致させる。
    """
    difficulties: list[SegmentDifficulty | None] = [None] * len(distances_km)
    for read in reads:
        values = read.values
        scores = {axis_id: arr[read.value_rows].tolist() for axis_id, arr in values.axis_arrays.items()}
        # 密度の軸は、ビンと候補で得点を作り直すために横軸の値を載せる（点数と同じ区間が欠損になる）。
        shares = axis_weight_shares_at_rows(values.axis_arrays, values.weights, values.weight_sums, read.value_rows)
        contributions = axis_contributions_at_rows(scores, shares)
        composite = values.difficulty_array[read.value_rows].tolist()
        density = {axis_id: column.inputs[read.rows].tolist() for axis_id, column in read.leg.density_axes.items()}
        for position, index in enumerate(read.indices):
            distance_km = distances_km[index]
            difficulties[index] = SegmentDifficulty(
                distance_km=round(distance_km, DISTANCE_KM_DECIMALS),
                difficulty=None if math.isnan(composite[position]) else composite[position],
                axis_difficulties={
                    axis_id: score[position] for axis_id, score in scores.items() if not math.isnan(score[position])
                },
                axis_contributions=contributions[position],
                density_inputs={
                    axis_id: DensityScoreInput(
                        value=inputs[position],
                        distance_km=distance_km,
                        weight_share=shares[position].get(axis_id),
                        shape=read.leg.density_axes[axis_id].shape,
                    )
                    for axis_id, inputs in density.items()
                    if not math.isnan(inputs[position])
                },
            )
    return difficulties


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
    difficulties: list[SegmentDifficulty]


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
        context.legs, context.turn_structure, entries, path,
        [edge.distance_m for edge in edges_in_path], leg_of_edge, context.composer.speed_kmh,
    )
    reads = _row_reads(context, rows, leg_of_edge, passages)
    difficulties = _segment_difficulties(reads, [edge.distance_m / 1000 for edge in edges_in_path])
    return _Orientation(
        edges_in_path, path, leg_of_edge, waypoint_offsets, rows, entries, passages, reads, difficulties
    )


def _build_best_candidate(
    context: RoadGraphContext,
    traced: TracedLoop,
    edges_in_path: list[LeanEdge],
    start_time: datetime,
    active_material_ids: set[str],
) -> EvaluatedRoute:
    """1候補ぶんの周回を組み立てる。

    同じ周回の逆回りは追加のI/Oなしで評価できるため、両向きの区間の難しさから**難易度の小さい向きだけ**を
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
        if prefers_reverse(chosen.difficulties, reverse.difficulties):
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
        list(zip((segment.distance_km for segment in segments), segment_raw_values))
    )
    # 返すsegmentsは集約する。Edge単位のままだとペイロードとフロントの描画費用が嵩む。
    segments = aggregate_segments_into_bins(segments)
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

    難しさの値は向きを選ぶときに読んだもの（`_Orientation.difficulties`）、材料値は同じ値の組
    （`_Orientation.reads`）から読む。区間は検証せずに組み、検証はビン（`domain/route.py: aggregate_segments_into_bins`）でだけ行う。
    到達予想時刻は経路を探索と同じ規則でたどった時刻（`passages`）。
    """
    count = len(orientation.edges)
    material_values: list[dict[str, float]] = [{}] * count
    segment_categories: list[dict[str, str]] = [{}] * count
    segment_raw_values: list[dict[str, float]] = [{}] * count
    for read in orientation.reads:
        materials = {
            material_id: array[read.value_rows].astype(float).tolist()
            for material_id in active_material_ids
            if (array := read.values.material_arrays.get(material_id)) is not None
        }
        categories = {
            material_id: [column.vocab[code] for code in column.codes[read.rows].tolist()]
            for material_id, column in read.leg.categorical_material_arrays.items()
            if material_id in active_material_ids
        }
        # 折れ点を通す前の生値。静的スコア行列が持つ列をそのまま読む
        # （動的材料を参照する軸は行列側で除外済み）。
        raw = {axis_id: arr[read.rows].tolist() for axis_id, arr in read.leg.axis_raw_arrays.items()}
        for position, index in enumerate(read.indices):
            material_values[index] = {
                material_id: column[position] for material_id, column in materials.items()
                if not math.isnan(column[position])
            }
            segment_categories[index] = {
                material_id: column[position] for material_id, column in categories.items()
                if column[position] is not None
            }
            segment_raw_values[index] = {
                axis_id: column[position] for axis_id, column in raw.items() if not math.isnan(column[position])
            }

    segments = []
    road_classes = SegmentClassReader.of(context.road)
    for index, (edge, row, difficulty) in enumerate(zip(orientation.edges, orientation.rows, orientation.difficulties)):
        rounded_km = difficulty.distance_km
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
                axis_difficulties=difficulty.axis_difficulties,
                axis_contributions=difficulty.axis_contributions,
                material_values=material_values[index],
                difficulty=difficulty.difficulty,
                road_classes={
                    layer: [RoadClassStretch.model_construct(distance_km=rounded_km, value=value)]
                    for layer, value in road_classes.values_at(row).items()
                },
            ).with_density_inputs(difficulty.density_inputs)
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
