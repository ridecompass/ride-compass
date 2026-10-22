"""探索が選んだ経路（`TracedLoop`）を、応答の候補（`EvaluatedRoute`）へ組み立てる。

- **区間表示は探索と同じコスト配列・スコア行列から引く。** 二重に計算しない。
- **標高・風は探索フェーズで読んだ材料の中にある。** 経路確定後に外部へ取りに行かない。
"""

import asyncio
import math
from dataclasses import replace
from datetime import datetime, timedelta

import numpy as np

from app.domain.attributes import ElevationAttribute
from app.domain.evaluation import (
    displayed_material_ids,
)
from app.domain.leg_costs import RowValues, material_value_at
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
    pick_better_candidate,
    reverse_leg_assignment,
    route_passages,
)
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
    topology = {
        index: lean_edge(context, index)
        for index in dict.fromkeys(index for t in traced for index in t.data)
    }
    hydrated = await graph_service.get_edges_with_geometry(list(topology.values()))
    edges_by_candidate: list[list[LeanEdge]] = [
        [hydrated[topology[index].edge_id] for index in t.data] for t in traced
    ]
    # 表示する材料は共有の軸定義（`domain/axis_definitions.py: AXIS_DEFINITIONS`）から決まるので、
    # 軸の差し替えと同じイベントループの上で1回だけ決め、スレッドの先では読ませない。
    active_material_ids = displayed_material_ids(context.composer.weights)
    return await asyncio.to_thread(
        lambda: [
            _build_best_candidate(context, t, edges_in_path, start_time, active_material_ids)
            for t, edges_in_path in zip(traced, edges_by_candidate)
        ]
    )


def _build_best_candidate(
    context: RoadGraphContext,
    traced: TracedLoop,
    edges_in_path: list[LeanEdge],
    start_time: datetime,
    active_material_ids: set[str],
) -> EvaluatedRoute:
    """1候補ぶんの周回を組み立てる。

    同じ周回の逆回りは追加のI/Oなしで合成できるため、合成して**難易度の小さい方だけ**を
    残す（両方向を別候補として並べない）。逆走は勾配・風で評点が変わるため常に意味がある。
    一方通行Edgeが1つでもあれば成立しないので、その場合は順方向のみ。

    逆に回ると置いた順が崩れる経路・出発地へ戻らない経路（`TracedLoop.reversible`が偽）は逆回りを作らない。
    """
    path: list[int] = traced.data
    elevation_by_edge = _elevation_by_edge(context, edges_in_path, path)
    leg_of_edge = traced.leg_of_edge
    forward_candidate = _build_candidate(
        context, traced, edges_in_path, path, elevation_by_edge, start_time, leg_of_edge,
        traced.waypoint_offsets, active_material_ids,
    )

    if not traced.reversible:
        return forward_candidate

    reversed_path = _reverse_traced_edges(edges_in_path, path, context)
    if reversed_path is None:
        return forward_candidate
    reverse_edges, reverse_path = reversed_path
    reverse_elevation = reverse_elevation_by_edge(edges_in_path, reverse_edges, elevation_by_edge)
    reverse_candidate = _build_candidate(
        context, traced, reverse_edges, reverse_path, reverse_elevation, start_time,
        reverse_leg_assignment(leg_of_edge),
        # 逆に回ると、経由地より前の区間は経由地より後の区間になる。
        [len(path) - offset for offset in traced.waypoint_offsets],
        active_material_ids,
    )
    return pick_better_candidate(forward_candidate, reverse_candidate)

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
    edges_in_path: list[LeanEdge],
    path: list[int],
    elevation_by_edge: dict[str, ElevationAttribute],
    start_time: datetime,
    leg_of_edge: list[int],
    waypoint_offsets: list[int],
    active_material_ids: set[str],
) -> EvaluatedRoute:
    # 区間と標高属性を引数で受けるのは、逆回り候補も同じ組み立てを通すため。
    # distance_km・bearingは同じ物理経路なので順方向の`traced`のものをそのまま使う。
    geometry, edge_point_offsets = concat_edge_geometries(edges_in_path)
    rows = [slice_row_of(context, index) for index in path]
    # 経路を探索と同じ規則でたどった区間ごとの時刻。区間の到達予想と候補の所要時間が同じ時計を使う。
    passages = route_passages(
        context.legs, context.turn_structure, path, rows,
        [edge.distance_m for edge in edges_in_path], leg_of_edge, context.composer.speed_kmh,
    )
    along_km = along_route_km(edge.distance_m / 1000 for edge in edges_in_path)
    segments, segment_categories, segment_raw_values = _build_segment_details(
        edges_in_path, along_km, rows, passages, elevation_by_edge, context, start_time, leg_of_edge,
        active_material_ids,
    )
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
    turns = _route_turns(context.turn_structure, path, edges_in_path, along_km)

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
        waypoint_distances_km=[along_km[offset] for offset in waypoint_offsets],
        segments=segments,
        material_category_shares=material_category_shares,
        axis_raw_values=axis_raw_values,
        # 所要時間＝区間の走行時間＋停止の待ち＋ターンの待ち（最後の区間を抜けた時刻）。
        estimated_duration_seconds=passages[-1].elapsed_seconds + passages[-1].seconds if passages else None,
        wind_unavailable=context.composer.wind_unavailable,
        missing_travel_data_share=(
            context.composer.missing_travel_data_share(np.asarray(rows, dtype=np.int64)) if rows else None
        ),
        elevation_gain_m=route_elevation_gain(edges_in_path, elevation_by_edge),
    )

def _build_segment_details(
    edges: list[LeanEdge],
    along_km: list[float],
    rows: list[int],
    passages: list[EdgePassage],
    elevation_by_edge: dict,
    context: RoadGraphContext,
    start_time: datetime,
    leg_of_edge: list[int],
    active_material_ids: set[str],
) -> tuple[list[RouteSegmentDetail], list[dict[str, str]], list[dict[str, float]]]:
    """区間ごとの表示値と、区間ごとのcategorical材料の値（材料id→値）・軸の生値（axis_id→値）を組み立てる。
    categorical材料の値は平均できず区間の器（ビンへ畳まれる）に載せられないため、軸の生値は画面が
    候補全体の値しか読まないため、どちらも候補全体へ畳む`_build_candidate`へ並びのまま渡す。

    軸別スコア・合成difficulty・寄与度・材料値は、
    そのEdgeが探索されたレグ（`leg_of_edge`）の合成済み配列（`context.legs`、
    区間の番号から行を引く）からそのまま読み、探索コストと表示を一致させる
    （二重計算を持たない）。到達予想時刻は経路を探索と同じ規則でたどった時刻（`passages`）。
    """
    segments = []
    segment_categories: list[dict[str, str]] = []
    segment_raw_values: list[dict[str, float]] = []
    road_classes = SegmentClassReader.of(context.road)
    timed = _values_at_passages(context, rows, leg_of_edge, passages)
    winds = context.composer.winds_at(
        rows,
        [_passage_hours_of(context, row, leg_index, passage)
         for row, leg_index, passage in zip(rows, leg_of_edge, passages)],
        [passage.beyond_bins for passage in passages],
    )

    for index, (edge, row, leg_index) in enumerate(zip(edges, rows, leg_of_edge)):
        leg = context.legs[leg_index]
        # 時刻で変わる値（難易度・軸・材料）は、探索がこの区間に使ったビンの値。ビンが1本のレグはレグの配列、
        # 2本以上のレグは経路上の行だけをそのビンの時刻で合成し直した値（`LegCostArrays.bin_start_hours`参照）。
        values, value_row = timed.get(index, (leg, row))
        distance_km = edge.distance_m / 1000
        rounded_km = round(distance_km, DISTANCE_KM_DECIMALS)
        elevation_attr = elevation_by_edge.get(edge.edge_id)

        gradient_percent = elevation_attr.average_grade if elevation_attr else None
        # 勾配は地図の配信と同じ桁へ丸めた値で、材料の列の値を上書きする。
        static_material_values = (
            {GRADIENT_PERCENT: round(gradient_percent, GRADIENT_VALUE_DECIMALS)}
            if GRADIENT_PERCENT in active_material_ids and gradient_percent is not None
            else {}
        )

        axis_scores = {
            axis_id: float(arr[value_row])
            for axis_id, arr in values.axis_arrays.items()
            if not math.isnan(arr[value_row])
        }
        axis_contributions = values.axis_contributions_at(value_row)
        # 密度の軸は、ビンと候補で得点を作り直すために横軸の値を載せる（点数と同じ区間が欠損になる）。
        weight_shares = values.axis_weight_shares_at(value_row)
        density_inputs = {
            axis_id: DensityScoreInput(
                value=float(column.inputs[row]),
                distance_km=distance_km,
                weight_share=weight_shares.get(axis_id),
                shape=column.shape,
            )
            for axis_id, column in leg.density_axes.items()
            if not math.isnan(column.inputs[row])
        }
        # 折れ点を通す前の生値。静的スコア行列が持つ列をそのまま読む
        # （動的材料を参照する軸は行列側で除外済み）。
        segment_raw_values.append({
            axis_id: float(arr[row])
            for axis_id, arr in leg.axis_raw_arrays.items()
            if not math.isnan(arr[row])
        })
        difficulty_value = values.difficulty_array[value_row]
        composite_difficulty_value = None if math.isnan(difficulty_value) else float(difficulty_value)
        material_values = {
            **{
                material_id: value
                for material_id in active_material_ids
                if (value := material_value_at(values, material_id, value_row)) is not None
            },
            **static_material_values,
        }
        segment_categories.append({
            material_id: raw
            for material_id, column in leg.categorical_material_arrays.items()
            if material_id in active_material_ids and (raw := column.value_at(row)) is not None
        })

        arrival_time = start_time + timedelta(seconds=passages[index].elapsed_seconds)

        start_lat, start_lon = edge.geometry[0]
        end_lat, end_lon = edge.geometry[-1]
        # 区間の道なり形状はEdgeの形状点列そのもの（追加取得なし）。2点未満のEdgeは
        # 形状にならないためNone（フロントは始点・終点の直線で代替描画する）。
        segment_coordinates = [[lon, lat] for lat, lon in edge.geometry]

        segments.append(
            RouteSegmentDetail(
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
                    ElevationStretch(
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
                axis_difficulties=axis_scores,
                axis_contributions=axis_contributions,
                material_values=material_values,
                difficulty=composite_difficulty_value,
                wind=winds[index],
                road_classes={
                    layer: [RoadClassStretch(distance_km=rounded_km, value=value)]
                    for layer, value in road_classes.values_at(row).items()
                },
            ).with_density_inputs(density_inputs)
        )

    return segments, segment_categories, segment_raw_values


def _values_at_passages(
    context: RoadGraphContext, rows: list[int], leg_of_edge: list[int], passages: list[EdgePassage]
) -> dict[int, tuple[RowValues, int]]:
    """ビンが2本以上あるレグの区間を、探索が使ったビンの時刻で合成し直す（区間の添字→（値, 値の中の位置））。
    同じレグ・同じビンの区間はまとめて1回で合成する。"""
    groups: dict[tuple[int, int], list[int]] = {}
    for index, (leg_index, passage) in enumerate(zip(leg_of_edge, passages)):
        if len(context.legs[leg_index].bin_start_hours) > 1:
            groups.setdefault((leg_index, passage.time_bin), []).append(index)
    timed: dict[int, tuple[RowValues, int]] = {}
    for (leg_index, time_bin), indices in groups.items():
        group_rows = np.array([rows[i] for i in indices], dtype=np.int64)
        hours = np.full(len(group_rows), context.legs[leg_index].bin_start_hours[time_bin])
        values = context.composer.values_at_rows(group_rows, hours)
        for position, index in enumerate(indices):
            timed[index] = (values, position)
    return timed


def _passage_hours_of(context: RoadGraphContext, row: int, leg_index: int, passage: EdgePassage) -> float | None:
    """その区間の評価に使った通過時刻（出発からの経過[h]）。出発時点の値で合成したレグはNone。"""
    leg = context.legs[leg_index]
    if leg.bin_start_hours:
        return leg.bin_start_hours[passage.time_bin]
    if leg.passage_hours is not None:
        return float(leg.passage_hours[row])
    return None


_TURN_DIRECTION = {TurnKind.LEFT: "left", TurnKind.RIGHT: "right", TurnKind.UTURN: "uturn"}


def _route_turns(
    structure: TurnExpandedStructure, path: list[int], edges_in_path: list[LeanEdge], along_km: list[float]
) -> list[RouteTurn]:
    """経路が分かれ道で曲がる所を、応答の形にする。距離は曲がった先の区間の始まりの道のり（`along_km`）、地点はその区間の始点。"""
    turns = []
    for turn in turns_along(structure, path):
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
