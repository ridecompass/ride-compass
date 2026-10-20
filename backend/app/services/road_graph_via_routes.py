"""距離なしの仕上げ: 最後の固定点から終点までを、互いに異なる道の候補（via-node）と、所要時間が最短の基準線で結ぶ。"""

import asyncio
import logging

import numpy as np

from app.domain.stopwatch import elapsed_ms, start_timer
from app.domain.route_search import (
    DETOUR_RATIO_MIN_ROAD_M,
    alternative_via_nodes,
    best_first,
    corridor_overlap_ratios,
    leg_of_edge_by_half,
    rank_by_pareto_layers,
)
from app.domain.routing import (
    add_terminal_candidate,
    build_turn_expanded_tree,
    combine_forward_backward_at_nodes,
    turn_expanded_path_from_state,
    turn_expanded_path_from_state_to_source,
    turn_expanded_shortest_path,
)
from app.domain.route_diversity import select_diverse_by_overlap
from app.domain.wind import (
    cruise_hours,
    estimate_passage_hours,
    reached_or_estimated_hours,
    straight_line_hours,
)
from app.domain.loop_routing import TracedLoop
from app.services.road_graph_context import (
    RoadGraphContext,
    FixedLegs,
    node_key_of,
    node_label,
    leg_name,
    leg_anchor,
    path_km,
    origin_states,
    destination_states,
    measured_detour_ratio,
    learn_detour_ratio,
    heuristic_to,
    traveled_columns,
    avoiding_traveled,
    physical_segments,
)

# ランキング上位から間引き判定にかけるvia-node候補数の上限（経路復元コストの上限）。目的地ルートのbboxは周回より
# 小さいため、上限は小さくてよい。
_MAX_VIA_NODE_CANDIDATES_EXAMINED = 2000

logger = logging.getLogger("ridecompass.graph")


async def select_via_nodes(
    context: RoadGraphContext, fixed: FixedLegs, max_routes: int, penalty_strength: float,
) -> list[TracedLoop]:
    """距離なしの仕上げ: 最後の固定点（経由地が無ければ起点）から終点（`fixed.end_node`）までの区間を、
    via-node方式で互いに異なる道に`max_routes`件まで選び、前段の道とつないで返す。代わりの道は最後の区間でだけ探す
    ——置いた点までは全候補で同じで、最後だけが違う（区間ごとに代わりを探すと組み合わせが増える）。
    周回のretraceペナルティ付き復路探索（`road_graph_engine.py: RoadGraphEngine.trace_loop_from_turnaround`）とは異なり、最後の固定点からの前向き木・
    終点からの後ろ向き木（遷移の向きを反転した辺基準の木）を各1回求めれば、どのNode（via-node）を経由する経路も
    両木の経路復元だけで確定するため、候補ごとの追加探索が発生しない。前段で走った道（同じNode対の逆向きを含む）には、
    両方の木で帰りと同じ罰を置く。

    1. 全Nodeについて経由路長`len_f+len_b`・合成コスト`cost_f+cost_b`をベクトル計算し、
       合成コスト最小のNode（"最良路"）の長さの`domain/route_search.py: alternative_max_stretch`倍以内の
       Nodeだけを候補にする。
    2. 平均difficulty`(合成コスト/経由路長-1)/P`昇順に並べる。ただし最良路のNodeは常に
       先頭へ回す——合成コスト最小であっても、伸び率の許す範囲でより平均difficultyの
       低い経路が他に存在すれば難易度順ではそちらが上位に来うるため、「最良路は必ず
       結果に含まれる」をランキングとは独立に保証する。
    3. `select_diverse_by_overlap`で、前向き経路・後ろ向き経路が同じEdgeを共有する
       Node（行って戻る形になり経路として成立しない）を除外しつつ、採用済み候補との
       重複率（最後の区間どうし）が閾値超のものを飛ばして`max_routes`件採る。

    終点は起点・経由地と同じく出て戻れるNodeへスナップしてある（`road_graph_engine.py: RoadGraphEngine.trace_fixed_points`）ので、走り出す点からの前向き木は必ず届く。
    """
    leg_index = len(fixed.segments)
    start_node = fixed.last_node
    start_point = leg_anchor(context, leg_index, start_node)
    fixed_hours = cruise_hours(fixed.length_m / 1000, context.composer.speed_kmh)
    destination_index, destination = fixed.end_node, fixed.end_point
    traveled = traveled_columns(context, fixed.edges)

    tree_started = start_timer()
    # 往路レグを、最後の固定点→終点の見込み所要時間ぶんの時刻ビンで組み直す。
    outbound = context.composer.compose(
        leg_name(leg_index), start_point, fixed_hours, +1,
        duration_hours=straight_line_hours(
            start_point, destination, context.composer.speed_kmh, context.composer.detour_ratio,
        ),
    )
    context.legs = [*context.legs[:leg_index], outbound]
    forward_tree = await asyncio.to_thread(
        build_turn_expanded_tree,
        context.turn_structure, avoiding_traveled(outbound.cost_bins_lazy, traveled), context.statics.edge_length_m,
        origin_states(context.statics, start_node), context.statics.csr.node_count,
        edge_seconds=outbound.travel_bins_lazy, bin_seconds=outbound.bin_seconds,
    )

    # 迂回率は前向き木（走り出す点から`DETOUR_RATIO_MIN_ROAD_M`以上先の到達Node）の実測中央値を使い、学習値として保存する。
    reached = np.flatnonzero(
        np.isfinite(forward_tree.node_cost) & (forward_tree.node_length_m >= DETOUR_RATIO_MIN_ROAD_M)
    )
    detour_ratio_median = measured_detour_ratio(context, start_node, reached, forward_tree.node_length_m[reached])
    inbound_detour_ratio = learn_detour_ratio(context, detour_ratio_median)
    # 後ろ向き木は終点へ向かうレグ: 終点を基準点に、到着予定時刻を
    # 「前段の見込み時間＋走り出す点〜終点の直線距離×迂回率÷仮定速度」に置いて合成する。
    arrival_hours = fixed_hours + straight_line_hours(
        start_point, destination, context.composer.speed_kmh, inbound_detour_ratio,
    )
    # 後ろ向き木は時刻ラベルを持てない（終点から遡るため各状態の到達時刻が決まらない）。
    # 代わりに、前向き木が出した「走り出す点からその区間へ実際に到達する時間」を通過時刻として
    # 渡す——直線距離からの推定より実態に近く、候補は伸び率の上限内に収まるため
    # ずれもその範囲に収まる。前向き木が届かない区間だけ直線距離の推定へ落とす。
    forward_seconds_lazy = forward_tree.node_seconds[context.turn_structure.edge_from]
    forward_hours = context.composer.to_full_row_order(forward_seconds_lazy) / 3600.0 + fixed_hours
    fallback_hours = estimate_passage_hours(
        context.composer.mid_lat, context.composer.mid_lon,
        destination, arrival_hours, -1, context.composer.speed_kmh,
        detour_ratio=inbound_detour_ratio,
    )
    inbound = context.composer.compose(
        "inbound", destination, arrival_hours, -1,
        passage_hours=reached_or_estimated_hours(forward_hours, fallback_hours),
    )
    context.legs = [*context.legs[:leg_index + 1], inbound]
    backward_tree = await asyncio.to_thread(
        build_turn_expanded_tree,
        context.turn_structure, avoiding_traveled(inbound.cost_lazy, traveled), context.statics.edge_length_m,
        destination_states(context.turn_structure, destination_index),
        context.statics.csr.node_count, reverse=True, edge_seconds=inbound.travel_seconds_lazy,
    )
    tree_ms = elapsed_ms(tree_started)

    # Nodeで単に前向き＋後ろ向きを足すと、そのNodeで曲がる費用が抜ける。
    junction_started = start_timer()
    junction = combine_forward_backward_at_nodes(
        context.turn_structure, forward_tree, backward_tree, context.statics.csr.node_count
    )
    junction_ms = elapsed_ms(junction_started)
    # 終点そのものを経由Nodeとする経路（＝経由せず直行する経路）も候補に含める。
    # junctionは「入る区間×出る区間」の対で作るため、そこで終わる経路は現れない。
    add_terminal_candidate(junction, forward_tree, destination_index)
    reachable = np.isfinite(junction.cost)
    if not np.any(reachable):
        # 前向き木・後ろ向き木のどちらがどれだけ到達できているかを内訳として出す
        # （前向きのみ0なら走り出す側、後ろ向きのみ0なら終点側の孤立を疑える）。
        logger.warning(
            "select_via_nodes reachable=0 forward_reached=%d backward_reached=%d "
            "destination_reached_by_forward=%s start_reached_by_backward=%s tree_ms=%d",
            int(np.isfinite(forward_tree.node_cost).sum()), int(np.isfinite(backward_tree.node_cost).sum()),
            bool(np.isfinite(forward_tree.node_cost[destination_index])),
            bool(np.isfinite(backward_tree.node_cost[start_node])),
            tree_ms,
        )
        return []

    best_index, candidates = alternative_via_nodes(junction.cost, junction.length_m, reachable)
    best_length_m = float(junction.length_m[best_index])
    # 周回の折返し点選定と同じく、経路長・difficultyのパレート非劣解を先に並べる
    # （目的地ルートは目標距離を持たず代わりの道の長さの上限（較正値）以内という上限だけが効くぶん、
    # 難易度単独で並べると伸び率上限いっぱいの遠回りが上位を占めやすい）。
    ranking = rank_by_pareto_layers(
        candidates, junction.length_m[candidates], junction.cost[candidates], junction.seconds[candidates],
        penalty_strength,
        max_items=max_routes, max_examined=_MAX_VIA_NODE_CANDIDATES_EXAMINED, tie_by_distance=False,
    )
    ranked = candidates[ranking.order].tolist()
    if len(candidates) > _MAX_VIA_NODE_CANDIDATES_EXAMINED:
        logger.warning(
            "via-node候補を打ち切りました within_stretch=%d examined=%d "
            "（上位から順に見るため、打ち切られたのは並べた後の下位）",
            len(candidates), _MAX_VIA_NODE_CANDIDATES_EXAMINED,
        )
    ranked = best_first(ranked, best_index)

    halves_cache: dict[int, tuple[list[int], list[int]] | None] = {}

    def halves(node_index: int) -> tuple[list[int], list[int]] | None:
        """経由Nodeを通る最後の区間の（前向き, 後ろ向き）の区間の番号列。行って戻る形ならNone。"""
        if node_index in halves_cache:
            return halves_cache[node_index]
        halves_cache[node_index] = None
        forward_state = int(junction.forward_state[node_index])
        if forward_state < 0:
            return None
        forward_edges = turn_expanded_path_from_state(forward_tree, forward_state)
        backward_state = int(junction.backward_state[node_index])
        # backward_stateが-1なのは終点そのものを指す場合で、後ろ向きの区間は無い。
        backward_edges = (
            turn_expanded_path_from_state_to_source(backward_tree, backward_state) if backward_state >= 0 else []
        )
        # 行って戻る形（前向き・後ろ向きが同じ物理区間を通る）の判定は、
        # 進行方向を無視した物理区間キーで行う——
        # 同じ道でも逆方向Edge（別のedge_id/index）を通れば単純なEdge index
        # 集合の比較では検出できないため。
        if physical_segments(context, forward_edges).keys() & physical_segments(context, backward_edges).keys():
            return None
        halves_cache[node_index] = (forward_edges, backward_edges)
        return halves_cache[node_index]

    def full_edges(node_index: int) -> list[int] | None:
        found = halves(node_index)
        return None if found is None else found[0] + found[1]

    selected = select_diverse_by_overlap(
        ranked, full_edges, context.statics.edge_length_m,
        corridor_overlap_ratios(), max_routes,
    )

    traced: list[TracedLoop] = []
    for node_index in selected:
        found = halves(node_index)
        if found is None or not (found[0] or found[1]):
            continue
        path, leg_of_edge = fixed.joined(*found)
        traced.append(TracedLoop(
            bearing=None, distance_km=path_km(context, path), data=path, leg_of_edge=leg_of_edge,
            waypoint_offsets=fixed.waypoint_offsets, reversible=fixed.reversible,
        ))

    logger.info(
        "select_via_nodes reachable=%d within_stretch=%d examined=%d selected=%d max_routes=%d "
        "best_km=%.1f fixed_km=%.1f detour_ratio_median=%.2f tree_ms=%d junction_ms=%d",
        int(reachable.sum()), len(candidates), len(ranked), len(traced), max_routes,
        best_length_m / 1000, fixed.length_m / 1000, detour_ratio_median, tree_ms, junction_ms,
    )
    return traced

async def select_fastest_route(context: RoadGraphContext, fixed: FixedLegs) -> TracedLoop | None:
    """所要時間が最短の経路を1本返す（主観的な軸の重みを一切使わない基準線）。出発地から置いた経由地を置いた順に
    通り、終点で終わる。

    コスト配列に区間ごとの所要時間（走行モデル＋停止の待ち）を、遷移にはターンの待ちを
    そのまま秒で渡すため、得られるのは**時間最短**の経路になる。利用者の好み（軸の重み）を
    すべて0にしたときの経路であり、候補が基準線に対して何を犠牲に何を得たかを読むための
    物差しになる。置いた点どうしの区間も時間最短で結び直す（候補の前段の道は軸の重みで選んでいる）。

    **軸の重みは使わないが、0次フィルタは使う**——あれは好みではなく通行可否・走行可否の
    表明で、所要時間を優先する経路でも越えてよいものではない。除外Edgeの所要時間を
    `inf`にすることで表現する。

    `select_via_nodes`の後に呼ぶこと。最後の区間のレグを引き継ぐ。

    置いた点どうしの区間は候補と同じレグで測り、最後の区間は経路の所要時間が半分になる位置で前向き・後ろ向きの
    レグへ割る——他の候補と同じく概ね半分ずつ割れ、レグごとに時刻の異なる風の評価が候補間で揃う。
    """
    destination_index = fixed.end_node

    started = start_timer()
    stops = [*fixed.nodes, destination_index]
    path: list[int] = []
    leg_of_edge: list[int] = []
    waypoint_offsets: list[int] = []
    for leg_index, (from_node, to_node) in enumerate(zip(stops, stops[1:])):
        leg = context.legs[leg_index]
        time_bins = leg.travel_bins_lazy
        edges = await asyncio.to_thread(
            turn_expanded_shortest_path,
            context.turn_structure, time_bins, heuristic_to(context, to_node),
            origin_states(context.statics, from_node), to_node,
            time_bins, leg.bin_seconds,
        )
        if not edges:
            logger.debug("select_fastest_route to_node=%s", node_key_of(context.road, to_node))
            logger.warning("select_fastest_route no path to=%s", node_label(context, to_node))
            return None
        path.extend(edges)
        if to_node == destination_index:
            halves = leg_of_edge_by_half([float(leg.travel_seconds_lazy[index]) for index in edges])
            leg_of_edge.extend(leg_index + half for half in halves)
        else:
            leg_of_edge.extend([leg_index] * len(edges))
        if leg_index < len(fixed.segments):
            waypoint_offsets.append(len(path))
    distance_km = path_km(context, path)

    logger.info(
        "select_fastest_route fastest_km=%.1f edges=%d forward_edges=%d elapsed_ms=%d",
        distance_km, len(path), sum(1 for leg in leg_of_edge if leg < len(fixed.segments) + 1),
        elapsed_ms(started),
    )
    return TracedLoop(
        bearing=None, distance_km=distance_km, data=path, leg_of_edge=leg_of_edge,
        waypoint_offsets=waypoint_offsets, reversible=False,
    )
