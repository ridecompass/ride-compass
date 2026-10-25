"""Road Graph + 辺基準グラフ探索（A*/一対全Dijkstra、lazy評価）の自前ルーティングエンジン。

`RouteGenerator`が探索を委譲する先。構造と各段の役割は
docs/modules/backend/routing-engine.mdが持つ。ここには、このファイルを変更するときに
破ってはいけないことだけを書く。

- **Road Graphの取得は1リクエストにつき1回だけ。** 候補ごとにbboxで問い合わせず、
  `prepare`が取った1つのグラフを全候補で共有する。
- **Edgeコストはbbox全体ぶんを1回だけnumpyで合成し、探索へは配列のまま渡す。**
  探索中にPythonのコールバックもEdgeごとのオブジェクトも作らない。
- **候補ごとの探索は直列に実行する。** `trace_loop_from_turnaround`が共有のコスト配列を
  一時的に書き換えるため、並列化と両立しない。

割り切り: 同一Node間の並行Edgeは`build_lazy_road_graph`が元の行の小さい1本へ解消する
（トポロジはリクエストごとに変わるコストに依らず決める）。そのため並行Edgeの一方だけが0次
フィルタで除外されると、許可される側ではなく行の小さい側が残り、そのNode対が到達不能になりうる。
"""

import asyncio
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime

import numpy as np

from app.domain.stopwatch import elapsed_ms, start_timer
from app.domain.time_zone import JST, as_series_time
from app.domain.traffic import highway_rank
from app.domain.tuning import tuning_value
from app.domain.errors import RoutingError
from app.domain.evaluation import (
    StaticEdgeScoreMatrix,
    build_static_edge_score_matrix,
)
from app.domain.hard_filters import compute_routable_nodes, compute_search_exclusion
from app.domain.leg_costs import LegCostArrays, LegCostComposer
from app.domain.route_preference import RoutePreference
from app.domain.road_avoidance import AvoidanceLevel, RoadAvoidanceMasks
from app.domain.geo import (
    bearing_between,
    bearing_between_array,
    compass_degrees,
)
from app.domain.region import BoundingBox, bbox_covering_points
from app.domain.rain import StationRainMaterials, rain_material_columns
from app.domain.road_network import RoadSlice, material_arrays_of
from app.domain.route import (
    Coordinates,
    EvaluatedRoute,
    DISTANCE_KM_DECIMALS,
)
from app.domain.route_request import FixedPoints
from app.domain.route_search import (
    LengthBand,
    MAX_SNAP_CORRECTION_KM,
    corridor_overlap_ratios,
    leg_duration_hours,
    leg_of_edge_by_half,
    loop_max_overlap_ratio,
    order_by_bearing_spread,
    rank_by_pareto_layers,
    retrace_penalized,
    relay_band,
    turnaround_band,
    turnaround_ring_m,
    turnaround_separation,
)
from app.domain.search_graph import LazyRoadGraph, SearchGraphStatics, build_lazy_road_graph, build_search_graph_statics
from app.domain.node_spatial_index import NodeSpatialIndex, build_node_spatial_index, snap_to_accessible_node
from app.domain.turn_structure import (
    current_turn_cost,
    TurnExpandedStructure,
    build_turn_expanded_structure,
    edge_bearings,
)
from app.domain.routing import (
    TreePathOverlap,
    TurnExpandedTree,
    build_turn_expanded_tree,
    tree_cost_bound,
    largest_strongly_connected_nodes,
    nodes_reached_without_retracing,
    turn_expanded_path_edge_indices,
    turn_expanded_shortest_path,
)
from app.domain.route_diversity import overlap_ratio, physical_overlap_ratio, select_diverse_by_overlap
from app.domain.wind import (
    cruise_hours,
    detour_ratio_or_default,
)
from app.infrastructure import detour_ratio_cache
from app.infrastructure.debug_log import log_throttled_warning
from app.services.graph_service import GraphService
from app.domain.loop_routing import LoopTurnaround, TracedLoop
from app.services.weather_service import WeatherService
from app.services import road_graph_via_routes
from app.services.road_graph_candidates import evaluate_routes
from app.services.road_graph_context import (
    RoadGraphContext,
    FixedLegs,
    refuse_at_nodes,
    node_coordinates,
    snap_point,
    resolve_end,
    leg_name,
    path_km,
    lazy_index_of,
    origin_states,
    destination_states,
    measured_detour_ratio,
    learn_detour_ratio,
    heuristic_to,
    traveled_columns,
    avoiding_traveled,
    physical_segments,
)


# Road Graphを取得するbboxは、起点と置いた点の外接矩形に、自由に選ぶ部分の半径とこのマージンを足したもの。
# 実際の道なりは直線距離の外接矩形からはみ出ることが多い（川・線路等を迂回する等）ため、
# 探索が失敗しない程度の余裕を持たせる。半径に比例させつつ、最低値を設ける。
_BBOX_MARGIN_RATIO = 0.3
_BBOX_MARGIN_MIN_KM = 2.0

logger = logging.getLogger("ridecompass.graph")



def _static_score_matrix(road: RoadSlice, rain: StationRainMaterials | None) -> tuple[StaticEdgeScoreMatrix, int]:
    """切り出した区間の材料に、区間の中点に最も近い雨量計の観測（雨の材料）を足して静的スコア行列を組む。
    戻り値の2つ目は雨の材料を引くのにかかった時間（ms）。"""
    materials = material_arrays_of(road)
    started = start_timer()
    observed = {} if rain is None else rain_material_columns(rain, materials.mid_lat, materials.mid_lon)
    rain_ms = elapsed_ms(started)
    return build_static_edge_score_matrix(materials, observed), rain_ms


@dataclass
class _SearchGraph:
    """`prepare`が組む「bboxに対する探索用グラフ＋材料一式」。
    0次ハードフィルタ等の探索コスト算出の組み立ては`_build_search_graph`1箇所にある。
    """

    road: RoadSlice
    lazy_graph: LazyRoadGraph
    # bboxを覆うタイル集合（学習した迂回率の鍵）。
    tile_set: frozenset[tuple[int, int, int]]
    # `road_graph_context.py: RoadGraphContext`と同じ意味（フィールドdocstring参照）。`outbound`は基準点（起点側の
    # 座標）から離れていくレグとして合成済みの配列。
    composer: LegCostComposer
    outbound: LegCostArrays
    node_lat: np.ndarray
    node_lon: np.ndarray
    # 探索から除く区間（`domain/hard_filters.py: compute_search_exclusion`、切り出した区間の順。cost_arrayをinfに
    # するのに使ったのと同じ配列）。routable Node判定にこの配列をそのまま使い回す。
    excluded: np.ndarray


@dataclass(frozen=True)
class _TurnaroundSelection:
    """`RoadGraphEngine.select_loop_turnarounds`が木のあとの処理をスレッドの先で流した結果。帯が空なら`ring_nodes`は0で、
    `reached_nodes`に木が届いた点の数を持つ。"""

    ring_nodes: int
    examined: int
    detour_ratio_median: float
    turnarounds: list[LoopTurnaround]
    reached_nodes: int


@dataclass(frozen=True)
class _TurnaroundData:
    """`LoopTurnaround.data`（本エンジン固有）: 中継点（折返し点）のノード番号と、最後の固定点からの一対全木上の
    往路（区間の番号列）。`trace_loop_from_turnaround`が帰りの探索に使う。"""

    node: int
    outbound_edge_indices: list[int]
    outbound_length_m: float


def _waypoint_offsets_along(context: RoadGraphContext, nodes: list[int], waypoints: list[Coordinates]) -> list[int]:
    """置いた経由地を、組んだ経路（通るノードの列`nodes`）が置いた順に通る所（`TracedLoop.waypoint_offsets`）。
    1つでも通らなければ（乗り換えで経由地を飛ばした・寄せられない）空にする——並びの何番目が何番目の経由地かを
    崩さないため、通らない経由地だけを抜かない。"""
    offsets: list[int] = []
    start = 0
    for point in waypoints:
        snapped = snap_point(context, point)
        if snapped is None or snapped[0] not in nodes[start:]:
            return []
        # 同じNodeへ寄った経由地が続けば同じ所を通る（生成の前段の、長さ0の区間と同じ）。
        start = nodes.index(snapped[0], start)
        offsets.append(start)
    return offsets


class RoadGraphEngine:
    """評価条件は解決済みの値だけを受け取る（既定を持たない）。組み立ては
    `services/route_generation_setup.py: assemble_route_generation_setup`だけが行う。"""

    def __init__(
        self,
        graph_service: GraphService,
        weather_service: WeatherService,
        *,
        route_preference: RoutePreference,
        penalty_strength: float,
        road_avoidance: Mapping[str, AvoidanceLevel],
        assumed_speed_kmh: float,
    ):
        self._graph_service = graph_service
        # 仮定巡航速度（km/h、リクエスト単位で上書き可）。各Edgeの通過予定時刻・区間の
        # 到達予想時刻・所要時間の算出に使う。
        self._assumed_speed_kmh = assumed_speed_kmh
        self._weather_service = weather_service
        self._route_preference = route_preference
        # コスト式`所要時間 × (1 + P × difficulty/100)`のP＝「主観 vs 時間」の換算レート。
        self._penalty_strength = penalty_strength
        # 道のレイヤの行→避け方の段。
        self._road_avoidance = road_avoidance
        # 「なるべく避ける」区間の費用の倍率。較正値のため、組み立てた時点の値で1回の生成を通す。
        self._avoid_cost_multiplier = tuning_value("avoidance.avoid_cost_multiplier")
        # 交差点でのターンの費用（秒）。較正値のため、組み立てた時点の値で1回の生成を通す。
        self._turn_cost = current_turn_cost()

    async def _build_search_graph(
        self, bbox: BoundingBox, origin: Coordinates, now: datetime
    ) -> _SearchGraph | None:
        """bboxに対する探索用グラフ（lazy_graph）＋bbox全体ぶんのコスト配列を構築する。
        風の時別予報が無いときの風（出発時点の値）と、区間を通る時刻の昼夜は`origin`（起点）の地点で決める。
        時別予報は`bbox`を覆う格子点ごとに引く。

        雨の材料は、出発時刻ではなく今の観測（地図の雨と同じ値）。観測の履歴が無い・古いときは欠損のまま組み、
        雨の材料を読む軸はその生成で「データなし」になる。

        `GraphService.get_search_slice`が切り出した区間の材料と雨の観測から`StaticEdgeScoreMatrix`
        （静的Edge×公開軸スコア行列）を組み、動的軸（風、`evaluate_dynamic_axis_arrays`）と重み
        ベクトルを適用してコスト配列を**bbox全体ぶん1回だけ**numpyで合成する。探索本体へは
        合成済みのnumpy配列をそのまま渡すだけにする。
        """
        stage_started = start_timer()
        built = await self._graph_service.get_search_slice(bbox)
        slice_ms = elapsed_ms(stage_started)
        if built is None:
            return None
        road, tile_set = built
        if road.edge_count == 0:
            return None

        weather_started = start_timer()
        departure_wind = await self._weather_service.get_departure_wind(origin)
        # 探索範囲を覆う格子点ごとの時別風予報（MSMのローカルファイルから読む。外部API呼び出しは無い）。
        wind_series = await self._weather_service.get_wind_forecast_lattice(bbox)
        rain = await self._weather_service.get_station_rain_materials(datetime.now(JST))
        weather_ms = elapsed_ms(weather_started)
        if rain is None:
            log_throttled_warning("engine:rain-materials", "雨の観測の履歴が無いか古いため、雨の材料を欠損として探索範囲を組む")

        materials_started = start_timer()
        score_matrix, rain_ms = await asyncio.to_thread(_static_score_matrix, road, rain)
        materials_ms = elapsed_ms(materials_started)
        # 通過予定時刻の基準（出発時刻）。
        start = as_series_time(now)

        graph_started = start_timer()
        lazy_graph = await asyncio.to_thread(build_lazy_road_graph, road.edge_from, road.edge_to, road.node_count)
        graph_ms = elapsed_ms(graph_started)

        # --- bbox全体ぶんのコスト配列の合成（レグごと。まず起点から離れる往路レグ） ---
        cost_started = start_timer()
        # 迂回率は同じ探索範囲で前回の往路木から学習した値があればそれを使う（無ければ既定値）。
        learned_detour_ratio = detour_ratio_cache.get_detour_ratio(tile_set)

        def compose_outbound() -> tuple[RoadAvoidanceMasks, LegCostComposer, LegCostArrays]:
            search_masks = compute_search_exclusion(score_matrix, self._road_avoidance)
            composer = LegCostComposer(
                score_matrix, self._route_preference.weights, self._penalty_strength, search_masks,
                self._avoid_cost_multiplier, departure_wind,
                wind_series, start, self._assumed_speed_kmh, lazy_graph.edge_rows,
                detour_ratio=detour_ratio_or_default(learned_detour_ratio),
                twilight_origin=origin,
            )
            return search_masks, composer, composer.compose("outbound", 0.0, +1)

        search_masks, composer, outbound = await asyncio.to_thread(compose_outbound)
        cost_ms = elapsed_ms(cost_started)
        # 重み付き軸がすべてNaNのEdge比率（探索コストはbbox内平均difficultyで補完される。
        # 実際の発生頻度を把握するためのサマリ）。
        missing_axis_mask = np.isnan(outbound.difficulty_array)
        missing_axis_distance_ratio = float(
            score_matrix.distance_m[missing_axis_mask].sum() / float(score_matrix.distance_m.sum())
        )

        total_ms = elapsed_ms(stage_started)
        logger.info(
            "_build_search_graph edges=%d nodes=%d slice_ms=%d weather_ms=%d materials_ms=%d rain_ms=%d cost_ms=%d "
            "graph_ms=%d total_ms=%d rain_hour=%s time_varying=%s speed_kmh=%.1f detour_ratio=%.2f(%s) "
            "missing_axis_edges=%d missing_axis_distance_ratio=%.3f",
            road.edge_count, road.node_count, slice_ms, weather_ms, materials_ms, rain_ms, cost_ms, graph_ms, total_ms,
            "none" if rain is None else rain.latest_hour.strftime("%Y-%m-%dT%H"),
            composer.time_varying, self._assumed_speed_kmh, composer.detour_ratio,
            "learned" if learned_detour_ratio is not None else "default",
            int(missing_axis_mask.sum()), missing_axis_distance_ratio,
        )

        return _SearchGraph(
            road=road,
            lazy_graph=lazy_graph,
            tile_set=tile_set,
            composer=composer,
            outbound=outbound,
            node_lat=road.node_lat,
            node_lon=road.node_lon,
            excluded=search_masks.excluded,
        )

    async def _build_search_structures(
        self, search: _SearchGraph
    ) -> tuple[NodeSpatialIndex, np.ndarray, np.ndarray, SearchGraphStatics, TurnExpandedStructure]:
        """最寄りNodeの索引・置いた点を寄せてよいNode・通れる区間（区間の番号順）・CSR・ターン構造を組む。

        索引の候補は実際に経路探索可能な（Hard Constraint通過後も区間が1本以上残る）Nodeに
        絞る。絞らないと、幹線道路（highway=trunk等）にしか接続していない地理的最近傍Node
        （駅前が国道の交差点に直接面する場所が実例）が選ばれ、そこがHard Constraint除外後の
        グラフ上では孤立点になるため、すべての折返し点・経由地への探索が"no path found"で失敗する。
        区間が残っていても出て戻れないNode（孤立した小さな塊・一方通行の袋）は、置いた点を寄せるときに
        外す（`domain/node_spatial_index.py: snap_to_accessible_node`）。
        """
        started = start_timer()
        road = search.road
        routable = await asyncio.to_thread(
            compute_routable_nodes, road.edge_from, road.edge_to, search.excluded, road.node_count,
        )
        node_index = await asyncio.to_thread(build_node_spatial_index, search.node_lat, search.node_lon, routable)
        statics = await asyncio.to_thread(build_search_graph_statics, search.lazy_graph, search.composer.distance_m)
        passable = ~search.excluded[search.lazy_graph.edge_rows]
        accessible = await asyncio.to_thread(largest_strongly_connected_nodes, statics.csr, passable)
        index_ms = elapsed_ms(started)
        turn_started = start_timer()
        turn_structure = await asyncio.to_thread(self._build_turn_structure, search, statics)
        logger.info(
            "prepare structures edges=%d states=%d transitions=%d index_ms=%d turn_ms=%d",
            road.edge_count, turn_structure.state_count, len(turn_structure.target_state),
            index_ms, elapsed_ms(turn_started),
        )
        return node_index, accessible, passable, statics, turn_structure

    def _build_turn_structure(self, search: _SearchGraph, statics: SearchGraphStatics) -> TurnExpandedStructure:
        """状態＝有向区間の遷移構造。信号の有無・集まる道の最大階級はノードの事前集計列、
        区間の道路階級は`highway`の語彙から引く（`domain/traffic.py: highway_rank`）。"""
        road, lazy_graph = search.road, search.lazy_graph
        network = road.network
        rank_of_code = np.array([highway_rank(highway) for highway in network.highway_vocab], dtype=np.int64)
        edge_rank = rank_of_code[network.edge_highway[road.rows[lazy_graph.edge_rows]]]
        start_bearings, end_bearings = (
            edge_bearings(lazy_graph, bearing_deg[road.rows], search.node_lat, search.node_lon)
            for bearing_deg in (network.edge_start_bearing_deg, network.edge_end_bearing_deg))
        return build_turn_expanded_structure(
            statics.csr, lazy_graph, start_bearings, end_bearings, edge_rank, self._turn_cost,
            np.asarray(network.node_has_signals[road.nodes], dtype=bool),
            np.asarray(network.node_max_rank[road.nodes], dtype=np.int64),
            np.asarray(network.node_branch_count[road.nodes], dtype=np.int16),
        )

    async def prepare(
        self,
        origin: Coordinates,
        points: list[Coordinates],
        radius_km: float,
        now: datetime,
    ) -> RoadGraphContext | None:
        """`points`は置いた点（経由地・目的地）、`radius_km`は自由に選ぶ部分が届く見込みの半径（置いた点だけを
        つなぐなら0）。出発地と置いた点を覆う矩形をこの半径とマージンだけ広げるので、中継点がどの方位に選ばれても
        この1回の取得で足りる。

        起点は出て戻れるNodeへ寄せ（`domain/node_spatial_index.py: snap_to_accessible_node`）、寄せられなければ`RoutingError`。"""
        # nowは出発時刻。区間ごとの通過時刻（風・昼夜）はここからの経過で決まる。
        margin_km = max(_BBOX_MARGIN_MIN_KM, radius_km * _BBOX_MARGIN_RATIO)
        bbox = bbox_covering_points([origin, *points], radius_km + margin_km)

        search = await self._build_search_graph(bbox, origin, now)
        if search is None:
            return None
        node_index, accessible, passable, statics, turn_structure = await self._build_search_structures(search)
        snapped = snap_to_accessible_node(node_index, accessible, origin, MAX_SNAP_CORRECTION_KM)
        if snapped is None:
            raise RoutingError("no accessible node near origin")
        origin_node, moved = snapped
        if moved:
            logger.warning(
                "prepare moved origin to nearest accessible node lat=%.2f lon=%.2f",
                float(search.node_lat[origin_node]), float(search.node_lon[origin_node]),
            )

        return RoadGraphContext(
            road=search.road,
            origin_node=origin_node,
            node_index=node_index,
            accessible=accessible,
            passable=passable,
            lazy_graph=search.lazy_graph,
            composer=search.composer,
            legs=[search.outbound],
            origin=origin,
            node_lat=search.node_lat,
            node_lon=search.node_lon,
            statics=statics,
            turn_structure=turn_structure,
            tile_set=search.tile_set,
        )

    def _trace_leg(
        self, context: RoadGraphContext, leg_index: int, from_node: int, to_node: int, cumulative_m: float,
    ) -> list[int] | None:
        """置いた点どうしを結ぶ区間を1本、A*で探す。区間0は`prepare`が合成済みの往路レグそのもので、
        ほかは区間の起点を基準点に、それまでの実距離ぶんの経過時間に置いて合成し`context.legs`へ足す。"""
        if leg_index == 0:
            leg = context.legs[0]
        else:
            leg = context.composer.compose(
                leg_name(leg_index),
                cruise_hours(cumulative_m / 1000, context.composer.speed_kmh), +1,
            )
            context.legs.append(leg)
        return turn_expanded_shortest_path(
            context.turn_structure, leg.cost_bins_lazy, heuristic_to(context, to_node),
            origin_states(context.statics, from_node),
            to_node,
            leg.travel_bins_lazy, leg.bin_seconds,
        )

    async def trace_fixed_points(self, context: RoadGraphContext, points: FixedPoints) -> FixedLegs:
        """前段: 出発地から、置いた経由地を置いた順に区間ごとのA*で結び、仕上げが向かう終点を決める。経由地が無ければ
        出発地で止まる（区間は無い）。

        起点は`prepare`がスナップ済みのNodeをそのまま使い、経由地と目的地はここで起点と同じく出て戻れるNodeへスナップする。
        どれかを寄せられなければ`RoutingError`。
        """
        end = resolve_end(context, points.destination)
        if end is None:
            raise RoutingError("could not snap destination to road graph")
        end_node, end_point = end
        if not points.waypoints:
            return FixedLegs(segments=[], nodes=[context.origin_node], length_m=0.0, end_node=end_node, end_point=end_point)
        node_sequence = [context.origin_node]
        for point in points.waypoints:
            snapped = snap_point(context, point)
            if snapped is None:
                raise RoutingError("could not snap waypoints to road graph")
            node_sequence.append(snapped[0])

        trace_started = start_timer()
        context.legs = context.legs[:1]
        segments: list[list[int]] = []
        cumulative_m = 0.0
        for leg_index, (from_node, to_node) in enumerate(zip(node_sequence, node_sequence[1:])):
            segment = await asyncio.to_thread(self._trace_leg, context, leg_index, from_node, to_node, cumulative_m)
            if segment is None:
                raise RoutingError("no path found between waypoints")
            segments.append(segment)
            cumulative_m += float(context.statics.edge_length_m[segment].sum())
        logger.info("trace_fixed_points legs=%d wall_ms=%d", len(segments), elapsed_ms(trace_started))
        return FixedLegs(
            segments=segments, nodes=node_sequence, length_m=cumulative_m, end_node=end_node, end_point=end_point,
        )

    async def select_loop_turnarounds(
        self,
        context: RoadGraphContext,
        fixed: FixedLegs,
        distance_km: float,
        distance_tolerance_km: float,
        pool_size: int,
    ) -> list[LoopTurnaround]:
        """距離ありの中継点（折返し点）候補を、最後の固定点からの往路の軸的な良さの順に最大`pool_size`件選ぶ。

        1. 最後の固定点（経由地が無ければ起点）からの一対全最短経路木（`domain/routing.py: build_turn_expanded_tree`、
           軸重み付きコスト）を1回だけ求める。前段で走った道（同じNode対の逆向きを含む）には帰りと同じ罰を置く。
           探索は、帯の上限の距離までに積みうる木の費用の上界（`domain/routing.py: tree_cost_bound`）で打ち切る。
        2. 帯に入るNodeを選ぶ。終点からの逆向きの木で中継点から終点までの長さを取り、全長の見込み（前段＋往路＋帰り）が
           目標±許容に入るNode（`domain/route_search.py: relay_band`）。経由地の無い周回は帰りの最短を往路の長さで
           代え、木に沿った往路の**実距離**が周回のリングに入るNodeにする（`domain/route_search.py: turnaround_band`）。
           どちらも最短実距離ではなく軸コスト最適経路の実距離で定義する——重みを極端に振った設定ほど往路が遠回りする
           ため、最短実距離基準だと往路だけで目標の半分を超え距離フィルタで全滅する。
           行き来に来た道を戻るしかないNode（袋小路の奥。`domain/routing.py: nodes_reached_without_retracing`の外）は
           帯に入れない——帰りの罰は袋小路を通れるよう有限なので、そこで折り返す周回は来た道を戻る。
        3. 帯の中心からのずれ・往路の難易度のパレート層の順に並べる（`rank_by_pareto_layers`）。
        4. 上位から順に、既採用候補と往路の重複率が重なりの上限（`domain/route_search.py: corridor_overlap_ratios`）を
           超えるもの・最小の間隔（`domain/route_search.py: turnaround_separation`）より近いものを飛ばして`pool_size`件
           採る（同一コリドー上の隣接Nodeが上位を独占し似た周回が並ぶのを防ぐ）。
           埋まらなければ閾値を緩めた上限へ上げてやり直す。上位の決まった数で切らず、帯の全Nodeを間引きにかける。

        `context.legs`は前段のレグのあとに、往路（最後の固定点から離れるレグ）と帰り（終点へ向かうレグ）を置く。
        """
        statics = context.statics
        leg_index = len(fixed.segments)
        start_node = fixed.last_node
        fixed_m = fixed.length_m
        remaining_km = distance_km - fixed_m / 1000
        end_node = fixed.end_node
        # 往路レグを、見込み所要時間（残りの距離の半分÷巡航速度）ぶんの時刻ビンで組み直す。
        # 木は出発からの経過時間を持ち回れるため、風を推定ではなく実際の経過時間で引ける。
        outbound = await asyncio.to_thread(
            context.composer.compose,
            leg_name(leg_index),
            cruise_hours(fixed_m / 1000, context.composer.speed_kmh), +1,
            duration_hours=leg_duration_hours(remaining_km, context.composer.speed_kmh),
        )
        context.legs = [*context.legs[:leg_index], outbound]
        traveled = traveled_columns(context, fixed.edges)

        # 経由地の無い周回は、出発地からの往路と出発地への帰りの最短が同じ2点を結ぶので、帰りの最短を往路の長さで
        # 代えられる（リング）。逆向きの木を求めない。
        uses_ring = fixed.closes and leg_index == 0
        if uses_ring:
            ring_lower_m, outbound_upper_m, _ = turnaround_ring_m(distance_km, distance_tolerance_km)
            band_km = (ring_lower_m / 1000, outbound_upper_m / 1000)
        else:
            outbound_upper_m = LengthBand.from_km(distance_km, distance_tolerance_km).upper_m - fixed_m
            band_km = ((distance_km - distance_tolerance_km), (distance_km + distance_tolerance_km))
        if outbound_upper_m <= 0:
            logger.info("select_turnarounds fixed_km=%.1f exceeds the target", fixed_m / 1000)
            return []
        backward_tree = None
        if not uses_ring:
            # 帰りレグ: 終点へ向かうレグとして、全長の目標ぶんの所要時間を終点への到着予定時刻に置く。
            inbound = await self._compose_inbound(context, distance_km, remaining_km)
            context.legs = [*context.legs[:leg_index + 1], inbound]
            backward_tree = await asyncio.to_thread(
                lambda: build_turn_expanded_tree(
                    context.turn_structure, avoiding_traveled(inbound.cost_lazy, traveled), statics.edge_length_m,
                    destination_states(context.turn_structure, end_node), statics.csr.node_count,
                    reverse=True, edge_seconds=inbound.travel_seconds_lazy,
                )
            )
        tree_started = start_timer()

        def outbound_tree() -> TurnExpandedTree:
            outbound_costs = avoiding_traveled(outbound.cost_bins_lazy, traveled)
            cost_limit = tree_cost_bound(context.turn_structure, outbound_costs, statics.edge_length_m, outbound_upper_m)
            return build_turn_expanded_tree(
                context.turn_structure, outbound_costs, statics.edge_length_m,
                origin_states(statics, start_node), statics.csr.node_count,
                cost_limit=cost_limit, edge_seconds=outbound.travel_bins_lazy,
                bin_seconds=outbound.bin_seconds,
            )

        tree = await asyncio.to_thread(outbound_tree)
        tree_ms = elapsed_ms(tree_started)

        def select_from_tree() -> _TurnaroundSelection:
            length = tree.node_length_m
            if backward_tree is None:
                in_ring, closeness_m = turnaround_band(length, distance_km, distance_tolerance_km)
            else:
                in_ring, closeness_m = relay_band(
                    fixed_m, length, backward_tree.node_length_m, distance_km, distance_tolerance_km,
                )
                in_ring[end_node] = False
            in_ring[start_node] = False
            in_ring &= nodes_reached_without_retracing(
                statics.csr, context.passable, context.accessible, [start_node, end_node],
            )
            ring = np.flatnonzero(in_ring)
            if len(ring) == 0:
                return _TurnaroundSelection(0, 0, float("nan"), [], int(np.isfinite(tree.node_cost).sum()))

            ring_length = length[ring]
            detour_ratio_median = measured_detour_ratio(context, start_node, ring, ring_length)
            closeness_key = closeness_m[ring]
            ranking = rank_by_pareto_layers(
                ring, closeness_key, tree.node_cost[ring], tree.node_seconds[ring], self._penalty_strength,
                max_items=pool_size, max_examined=None, tie_by_distance=True,
            )
            order = ranking.order
            ranked = ring[order]
            ranked_list = ranked.tolist()
            # 同点（層と丸めた難易度が等しい）候補はグループとして渡し、グループ内の試行順は
            # 「採用済み候補との方位角距離の最小値が最大」（最遠点貪欲法、方位は生成機構ではなく
            # 同点タイブレーク専用）で採用のたびに決め直す。グループ自体の順序（主キー）・
            # 同点でない候補間の順序は変えない。
            origin_node = node_coordinates(context, context.origin_node)
            bearing_by_node = dict(zip(
                ranked_list,
                bearing_between_array(origin_node, context.node_lat[ranked], context.node_lon[ranked]).tolist(),
            ))
            closeness_by_node = dict(zip(ranked_list, closeness_key[order].tolist()))
            tie_groups = ranking.tie_groups(ring)

            def prefer(remaining: Sequence[int], selected: list[int]) -> list[int]:
                return order_by_bearing_spread(remaining, selected, bearing_by_node, closeness_by_node)

            far_enough = turnaround_separation(
                ranked_list, context.node_lat[ranked], context.node_lon[ranked],
                float(context.node_lat[context.origin_node]),
            )

            # 閾値を昇順に渡すと、埋まらなかったときの緩和までを1回の呼び出しで行う。
            selected = select_diverse_by_overlap(
                [], TreePathOverlap(tree),
                corridor_overlap_ratios(), pool_size, far_enough,
                tie_groups=tie_groups, prefer=prefer,
            )

            turnarounds: list[LoopTurnaround] = []
            for node_index in selected:
                edges = turn_expanded_path_edge_indices(tree, node_index)
                if not edges:
                    continue
                bearing = compass_degrees(bearing_between(origin_node, node_coordinates(context, node_index)))
                turnarounds.append(
                    LoopTurnaround(
                        bearing=bearing,
                        data=_TurnaroundData(
                            node=node_index, outbound_edge_indices=edges, outbound_length_m=float(length[node_index]),
                        ),
                    )
                )
            return _TurnaroundSelection(len(ring), len(ranked_list), detour_ratio_median, turnarounds, 0)

        # 木のあとの処理（帯・順位付け・方位の表・間引き・往路の取り出し）は帯の点の数だけ重いので、スレッドの先で流す。
        # 共有の状態へ書く迂回率の学習と帰りレグの差し替えは、ループの上に残す。
        selection = await asyncio.to_thread(select_from_tree)
        if selection.ring_nodes == 0:
            logger.info(
                "select_turnarounds ring_nodes=0 reached=%d ring_km=[%.1f,%.1f] fixed_km=%.1f tree_ms=%d",
                selection.reached_nodes, band_km[0], band_km[1], fixed_m / 1000, tree_ms,
            )
            return []
        # 迂回率（道なり距離÷直線距離）の実測中央値を学習値として保存する。周回の合成自体は
        # 使わない（レグはビンの開始時刻で評価する）が、直線距離を走行時間へ直す係数として
        # 目的地ルートの到着予定時刻が読む。
        learn_detour_ratio(context, selection.detour_ratio_median)
        if backward_tree is None:
            # 帰りレグ: 出発地へ向かうレグとして、周回の総所要時間（目標距離÷仮定速度）を出発地への
            # 到着予定時刻に置いて合成する（距離フィルタが目標±許容を強制するため定数扱いできる）。
            inbound = await self._compose_inbound(context, distance_km, remaining_km)
            context.legs = [*context.legs[:leg_index + 1], inbound]
        turnarounds = selection.turnarounds
        logger.info(
            "select_turnarounds ring_nodes=%d examined=%d selected=%d pool=%d "
            "ring_km=[%.1f,%.1f] fixed_km=%.1f detour_ratio_median=%.2f tree_ms=%d total_ms=%d",
            selection.ring_nodes, selection.examined, len(turnarounds), pool_size,
            band_km[0], band_km[1], fixed_m / 1000, selection.detour_ratio_median, tree_ms,
            elapsed_ms(tree_started),
        )
        return turnarounds

    async def _compose_inbound(
        self, context: RoadGraphContext, distance_km: float, remaining_km: float,
    ) -> LegCostArrays:
        """距離ありの帰りレグ: 終点を基準点に、全長の目標ぶんの所要時間（目標距離÷仮定速度）を終点への到着予定時刻に置く
        （距離フィルタが目標±許容を強制するため定数扱いできる）。"""
        return await asyncio.to_thread(
            context.composer.compose,
            "inbound", cruise_hours(distance_km, context.composer.speed_kmh), -1,
            duration_hours=leg_duration_hours(remaining_km, context.composer.speed_kmh),
        )

    async def select_via_nodes(self, context: RoadGraphContext, fixed: FixedLegs, max_routes: int) -> list[TracedLoop]:
        """距離なしの仕上げの候補（`road_graph_via_routes.py: select_via_nodes`）。"""
        return await road_graph_via_routes.select_via_nodes(context, fixed, max_routes, self._penalty_strength)

    async def select_fastest_route(self, context: RoadGraphContext, fixed: FixedLegs) -> TracedLoop | None:
        """所要時間が最短の基準線（`road_graph_via_routes.py: select_fastest_route`）。"""
        return await road_graph_via_routes.select_fastest_route(context, fixed)

    async def trace_loop_from_turnaround(
        self, context: RoadGraphContext, fixed: FixedLegs, turnaround: LoopTurnaround,
    ) -> TracedLoop:
        """前段の道と往路（最後の固定点からの一対全木上の経路、`select_loop_turnarounds`で確定済み）に、それまでに
        走った道を避けた帰り（中継点→終点のA*）を継いで1本にする。

        帰りの探索の間だけ、走った区間（前段＋往路）＋同一Node対の逆方向Edgeのコストを
        走った道を帰りで通る罰（`domain/route_search.py: retrace_penalized`）へ**差し替え**、探索後に元へ戻す。配列ごとコピーすると
        候補の数だけbbox全体ぶんの複製を払うため、触るのは走った区間の列だけにする。時刻ビンを
        張った帰りでは全ビンの同じ列をまとめて差し替える——どの時刻に通っても「走った道を
        なぞる」ことに変わりはない。

        **差し替え・探索・戻すは1つのスレッドの中で続けて行い、間にawaitを挟まないこと。** 共有のコスト配列を
        書き換えるため、この間に他のコルーチンへ制御が渡ると別の候補が書き換え後の値を見る。

        倍率は有限のため、帰りが走った道を戻る以外に道が無い区間（袋小路・起点付近の単一の道）は
        そのまま通れる。
        """
        data: _TurnaroundData = turnaround.data
        leg_index = len(fixed.segments)
        # 帰りレグのコスト配列（select_loop_turnaroundsが合成済み）。
        inbound_leg = context.legs[leg_index + 1]
        cost_bins = inbound_leg.cost_bins_lazy

        penalized_columns = traveled_columns(context, [*fixed.edges, *data.outbound_edge_indices])
        heuristic = heuristic_to(context, fixed.end_node)

        def search_avoiding_traveled() -> list[int] | None:
            original = cost_bins[:, penalized_columns]
            try:
                cost_bins[:, penalized_columns] = retrace_penalized(original)
                return turn_expanded_shortest_path(
                    context.turn_structure, cost_bins, heuristic,
                    origin_states(context.statics, data.node),
                    fixed.end_node,
                    inbound_leg.travel_bins_lazy, inbound_leg.bin_seconds,
                )
            finally:
                cost_bins[:, penalized_columns] = original

        trace_started = start_timer()
        return_edge_index_list = await asyncio.to_thread(search_avoiding_traveled)
        trace_wall_ms = elapsed_ms(trace_started)
        if return_edge_index_list is None:
            raise RoutingError(f"turnaround bearing={turnaround.bearing}: no return path found")

        if not return_edge_index_list:
            raise RoutingError(f"turnaround bearing={turnaround.bearing}: return path has no edges")
        return_edge_indices = np.array(return_edge_index_list, dtype=np.int64)
        retrace = overlap_ratio(return_edge_indices, penalized_columns, context.statics.edge_length_m)
        path, leg_of_edge = fixed.joined(data.outbound_edge_indices, return_edge_index_list)
        distance_km = path_km(context, path)
        logger.debug(
            "trace_loop_from_turnaround bearing=%d outbound_km=%.1f loop_km=%.1f retrace_ratio=%.2f wall_ms=%d",
            turnaround.bearing, data.outbound_length_m / 1000, distance_km, retrace, trace_wall_ms,
        )
        return TracedLoop(
            bearing=turnaround.bearing if fixed.closes else None, distance_km=distance_km, data=path,
            leg_of_edge=leg_of_edge, waypoint_offsets=fixed.waypoint_offsets, reversible=fixed.reversible,
        )

    def build_traced_from_edge_ids(
        self, context: RoadGraphContext, edge_ids: tuple[str, *tuple[str, ...]], points: FixedPoints,
    ) -> TracedLoop:
        """クライアントが組み立てたEdge id列を、評価できる経路として検証して`TracedLoop`にする。

        区間の乗り換えで使う。フロントは候補の`edge_ids`から
        「Aの前半＋Bの後半」を作って送り返すため、**このグラフに実在し・順につながり・
        起点から始まり・終点（目的地、無ければ出発地）へ着く**ことをここで確かめる（送られた列をそのまま信じると、
        評価は成功するのに経路として成立しないルートが候補一覧へ並ぶ。周回どうしを乗り換えた経路が出発地へ戻ることもここで決まる）。

        置いた経由地は生成と同じNodeへ寄せ、組んだ経路の中で置いた順に通る所を探す（`_waypoint_offsets_along`）。

        終点は生成と同じく出て戻れるNodeへ寄せて解くため、比べる相手は元の候補が
        実際に終わったNodeになる——目的地を寄せ直した場合も、
        寄せ直した後の地点が条件として返っており、合成もその地点で送られてくる。

        合成経路はvia-nodeを持たないため、レグはこの経路自身の距離で`leg_of_edge_by_half`が
        切る。**レグ番号を振る側が、その番号のレグを
        `context.legs`へ用意する**——`prepare`が作るのは往路レグだけで、復路レグは探索
        （折返し点の選定・経由Nodeの選定）が作る。合成経路はどちらの探索も通らない。
        """
        resolved = [lazy_index_of(context, edge_id) for edge_id in edge_ids]
        unknown = [edge_id for edge_id, index in zip(edge_ids, resolved, strict=True) if index is None]
        if unknown:
            # 区間の鍵はOSMの道のidを含むため、常時のログへ載る例外の文には件数だけを書く（logging.md 基本原則4）。
            logger.debug("経路に未知のEdgeが含まれています first=%s", unknown[0])
            raise RoutingError(f"経路に未知のEdgeが含まれています count={len(unknown)}")
        path = [index for index in resolved if index is not None]
        lazy_graph = context.lazy_graph
        tails = [int(lazy_graph.edge_from[index]) for index in path]
        heads = [int(lazy_graph.edge_to[index]) for index in path]
        if tails[0] != context.origin_node:
            refuse_at_nodes(context, "経路が起点から始まっていません", expected=context.origin_node, actual=tails[0])
        for index, (head, following_tail) in enumerate(zip(heads, tails[1:])):
            if head != following_tail:
                refuse_at_nodes(
                    context, f"経路がつながっていません index={index}", to_node=head, next_from_node=following_tail,
                )
        destination = points.destination
        snapped = (context.origin_node, False) if destination is None else snap_point(context, destination)
        if snapped is None:
            raise RoutingError("終点を道路網へ寄せられません")
        if heads[-1] != snapped[0]:
            refuse_at_nodes(context, "経路が終点に着いていません", expected=snapped[0], actual=heads[-1])

        lengths = context.statics.edge_length_m[path].tolist()
        total_m = sum(lengths)
        leg_of_edge = leg_of_edge_by_half(lengths)
        if max(leg_of_edge) > 0 and len(context.legs) < 2:
            total_hours = cruise_hours(total_m / 1000, context.composer.speed_kmh)
            context.legs = [
                context.legs[0],
                context.composer.compose(
                    "inbound", total_hours, -1,
                    duration_hours=leg_duration_hours(total_m / 1000, context.composer.speed_kmh),
                ),
            ]
        return TracedLoop(
            bearing=None, distance_km=round(total_m / 1000, DISTANCE_KM_DECIMALS), data=path, leg_of_edge=leg_of_edge,
            waypoint_offsets=_waypoint_offsets_along(context, [tails[0], *heads], points.waypoints), reversible=False,
        )

    def is_loop_too_similar(
        self, context: RoadGraphContext, fixed: FixedLegs, candidate: TracedLoop, accepted: list[TracedLoop]
    ) -> bool:
        """`candidate`が`accepted`のいずれかと、前段のあとの道（往路＋帰り）で
        重なりの上限（`domain/route_search.py: loop_max_overlap_ratio`）を超えて重複するか。前段の道は全候補で同じなので比べない。進行方向を無視して
        比較するため、「同じ周回の逆回り」（往路と帰りが入れ替わっただけ）や「往路は違うが
        帰りが同じ裏道へ収束する」周回のどちらも同じ判定で弾ける。`TracedLoop.data`は
        区間の番号列（前段＋往路＋帰り、`trace_loop_from_turnaround`参照）。
        """
        fixed_count = len(fixed.edges)
        candidate_lengths = physical_segments(context, candidate.data[fixed_count:])
        max_ratio = loop_max_overlap_ratio()
        for other in accepted:
            ratio = physical_overlap_ratio(candidate_lengths, physical_segments(context, other.data[fixed_count:]))
            if ratio > max_ratio:
                logger.debug(
                    "loop dedup rejected bearing=%s overlap_ratio=%.2f vs accepted bearing=%s",
                    candidate.bearing, ratio, other.bearing,
                )
                return True
        return False

    def repeated_shares(self, context: RoadGraphContext, traced: list[TracedLoop]) -> list[float]:
        """候補ごとの、同じ道（進行方向を問わない物理区間）を2度目以降に走る距離の割合（0〜1）。走った道を避けた
        効き目を、常時のサマリで数えるために出す。"""
        shares = []
        for candidate in traced:
            total_m = float(context.statics.edge_length_m[candidate.data].sum())
            once_m = sum(physical_segments(context, candidate.data).values())
            shares.append(1.0 - once_m / total_m if total_m > 0 else 0.0)
        return shares

    async def evaluate_loops(
        self, context: RoadGraphContext, traced: list[TracedLoop], start_time: datetime
    ) -> list[EvaluatedRoute]:
        """選んだ経路を応答の候補へ組み立てる（`road_graph_candidates.py: evaluate_routes`）。"""
        return await evaluate_routes(self._graph_service, context, traced, start_time)
