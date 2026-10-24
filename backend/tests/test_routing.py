"""`app/domain/routing.py`——計算済みのEdge Costで経路を探す層。

見るもの: 一対全の木と2点間探索の結果（コスト・時刻ビン・経路の復元）、木の繋ぎ目、置いた点を寄せてよいノード
（出て戻れる集まり）、探索のJITの型。

ここで見ないもの:
- Edge Costの中身（勾配・路面・風がどう秒へ化けるか） → `domain/evaluation.py`側
- 探索用グラフ・ターンの遷移の組み立て → `test_search_graph.py`・`test_turn_structure.py`
- 候補ルートの並べ方・返し方 → `route_generator`側
"""
import math
import sys
from datetime import datetime, timedelta, timezone

import numba
import numpy as np
import pytest
from hypothesis import example, given
from hypothesis import strategies as st
from numba.core import event
from numba.core.registry import CPUDispatcher

from app.domain import route_diversity, routing, search_graph
from app.domain.msm import MsmBlock, MsmGrid
from app.domain.wind import WindForecastSeries
from tests.route_world import (
    BASE_LAT,
    BASE_LON,
    CENTER,
    NO_POINTS,
    NORTH_EAST,
    SOUTH_WEST,
    at,
    avoid_axis_declared,
    generator_for,
    grid_network,
)
from tests.search_graph_world import (
    LINE_EDGES,
    LINE_NODES,
    PLUS_EDGES,
    PLUS_NODES,
    TURN_SPEC,
    build_all,
    make_graph,
    state_index,
)


def make_grid(size, cell=0.01, base_lat=35.0, base_lon=139.0):
    """`size`×`size`の格子。全Edgeが双方向・距離100m。"""
    nodes = {}
    edges = {}
    for row in range(size):
        for col in range(size):
            nodes[f"n{row}_{col}"] = (base_lat + row * cell, base_lon + col * cell)
    for row in range(size):
        for col in range(size):
            here = f"n{row}_{col}"
            if col + 1 < size:
                east = f"n{row}_{col + 1}"
                edges[f"{here}>{east}"] = (here, east, 100.0, 90.0)
                edges[f"{east}>{here}"] = (east, here, 100.0, 270.0)
            if row + 1 < size:
                north = f"n{row + 1}_{col}"
                edges[f"{here}>{north}"] = (here, north, 100.0, 0.0)
                edges[f"{north}>{here}"] = (north, here, 100.0, 180.0)
    return make_graph(nodes, edges)


def out_states(lazy, node_id):
    node_index = lazy.node_id_to_index[node_id]
    return np.flatnonzero(lazy.graph.edge_from == node_index).astype(np.int64)


# --- largest_strongly_connected_nodes ---


@given(st.integers(1, 7).flatmap(lambda n: st.tuples(
    st.just(n), st.lists(st.tuples(st.integers(0, n - 1), st.integers(0, n - 1), st.booleans()), min_size=1, max_size=20),
)))
def test_largest_strongly_connected_nodes_are_the_biggest_set_that_reach_each_other(graph):
    """置いた点を寄せてよいNodeは、通れる区間だけで互いに行き来できる一番大きな集まり。外れると、出られない・戻れない
    Nodeへ寄せた出発地・経由地から候補が出ないか、行き来できるNodeを寄せ先から外して遠くへ寄せる。
    比べる相手は、到達の推移閉包から作った互いに届くNodeの集まり（同じ大きさが並べば、どれか1つ）。"""
    node_count, edges = graph
    lazy = search_graph.build_lazy_road_graph(
        np.array([tail for tail, _, _ in edges]), np.array([head for _, head, _ in edges]), node_count)
    passable = np.array([edges[row][2] for row in lazy.edge_rows], dtype=bool)
    statics = search_graph.build_search_graph_statics(lazy, np.ones(len(edges)))

    found = routing.largest_strongly_connected_nodes(statics.csr, passable)

    reach = np.eye(node_count, dtype=bool)
    reach[lazy.edge_from[passable], lazy.edge_to[passable]] = True
    for middle in range(node_count):
        reach |= reach[:, [middle]] & reach[[middle], :]
    mutual = reach & reach.T
    groups = {frozenset(np.flatnonzero(mutual[node]).tolist()) for node in range(node_count)}
    largest = max(len(group) for group in groups)
    assert frozenset(np.flatnonzero(found).tolist()) in {group for group in groups if len(group) == largest}


# --- nodes_reached_without_retracing ---


def _connected(pairs: set[frozenset[int]], a: int, b: int) -> bool:
    reached, frontier = {a}, [a]
    while frontier:
        node = frontier.pop()
        for pair in pairs:
            if node in pair:
                (other,) = pair - {node} or {node}
                if other not in reached:
                    reached.add(other)
                    frontier.append(other)
    return b in reached


@given(st.integers(2, 8).flatmap(lambda n: st.tuples(
    st.just(n),
    st.lists(st.tuples(st.integers(0, n - 1), st.integers(0, n - 1), st.booleans()), min_size=1, max_size=20),
    st.lists(st.integers(0, n - 1), min_size=1, max_size=2),
)))
# 4点の輪から橋を1本渡った先の3点の輪（袋小路の先の輪）。起点は大きな輪の中。
@example((7, [(a, b, True) for x, y in [(0, 1), (1, 2), (2, 3), (3, 0), (3, 4), (4, 5), (5, 6), (6, 4)]
              for a, b in [(x, y), (y, x)]], [0]))
def test_turnarounds_are_the_nodes_whose_round_trip_retraces_no_more_than_the_terminals_must(graph):
    """折返し点にしてよいNodeは、どの橋（除くと向きを除いた網が分かれる区間）で分けても、起点・終点・一番大きな輪の
    集まりのどれかと同じ側に残るNode。外れると、行き止まりの奥で折り返して来た道を戻る周回が候補に混ざるか、起点が
    袋小路の中にあるときに折返し点が無くなって周回が出ない。比べる相手は、橋を1本ずつ除いてつながりを調べ直す素朴な
    計算（一番大きな塊が並べば、どれか1つ）。"""
    node_count, edges, terminal_picks = graph
    lazy = search_graph.build_lazy_road_graph(
        np.array([tail for tail, _, _ in edges]), np.array([head for _, head, _ in edges]), node_count)
    passable = np.array([edges[row][2] for row in lazy.edge_rows], dtype=bool)
    statics = search_graph.build_search_graph_statics(lazy, np.ones(len(edges)))
    within = routing.largest_strongly_connected_nodes(statics.csr, passable)
    inside = np.flatnonzero(within).tolist()
    terminals = [inside[pick % len(inside)] for pick in terminal_picks]

    found = routing.nodes_reached_without_retracing(statics.csr, passable, within, terminals)

    pairs = {
        frozenset((int(tail), int(head)))
        for tail, head, ok in zip(lazy.edge_from, lazy.edge_to, passable)
        if ok and tail != head and within[tail] and within[head]
    }
    bridges = [pair for pair in pairs if not _connected(pairs - {pair}, *pair)]
    loose = pairs - set(bridges)
    groups = {frozenset(other for other in inside if _connected(loose, node, other)) for node in inside}
    largest = max(len(group) for group in groups)
    expected = set()
    for core in (group for group in groups if len(group) == largest):
        targets = [*terminals, next(iter(core))]
        expected.add(frozenset(
            node for node in inside
            if all(any(_connected(pairs - {bridge}, node, target) for target in targets) for bridge in bridges)
        ))
    assert frozenset(np.flatnonzero(found).tolist()) in expected


# --- build_turn_expanded_tree ---


# 優先度キューの初期容量（種の数＋余裕）を確実に超える広さ。伸長の経路を普通の探索が通る、
# という設計をこの広さで実際に通す。
GRID_SIZE = 20


def grid_tree(**kwargs):
    graph = make_grid(GRID_SIZE)
    lazy, statics, structure = build_all(graph)
    cost = np.ones(structure.state_count)
    tree = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, out_states(lazy, "n0_0"),
        lazy.node_count, **kwargs,
        edge_seconds=np.ones(structure.state_count),
    )
    return lazy, statics, structure, tree


def test_tree_costs_equal_the_hop_count_from_the_origin():
    """種は自分自身の区間コストから始まるため、各Nodeのコストは通った区間の本数になる。

    起点Node自身は0にならない——状態の空間に「まだ走っていない」が無く、起点のコストは
    「起点へ戻ってくるコスト」（ここではUターン1回）になる。
    """
    lazy, _, _, tree = grid_tree()
    for node_id, node_index in lazy.node_id_to_index.items():
        row, col = (int(part) for part in node_id[1:].split("_"))
        hops = row + col
        expected = hops if hops else 2
        assert tree.node_cost[node_index] == pytest.approx(expected), node_id
        assert tree.node_length_m[node_index] == pytest.approx(expected * 100.0), node_id


def test_tree_seconds_come_from_the_plain_travel_time_not_from_the_cost():
    """秒はコスト（主観的割増込み）ではなく素の走行時間を積む。混ぜると到着時刻が狂う。"""
    lazy, statics, structure = build_all(make_graph(LINE_NODES, LINE_EDGES))
    states = state_index(lazy)
    tree = routing.build_turn_expanded_tree(
        structure, np.full(structure.state_count, 5.0), statics.edge_length_m,
        np.array([states["AB"]], dtype=np.int64), lazy.node_count,
        edge_seconds=np.full(structure.state_count, 2.0),
    )
    assert tree.state_cost[states["BC"]] == pytest.approx(10.0)
    assert tree.state_seconds[states["BC"]] == pytest.approx(4.0)


def test_tree_stops_at_the_cost_limit():
    """`cost_limit`を超える先へは伸ばさない（到達できるNodeだけが有限コストになる）。"""
    lazy, _, _, tree = grid_tree(cost_limit=3.0)
    for node_id, node_index in lazy.node_id_to_index.items():
        row, col = (int(part) for part in node_id[1:].split("_"))
        hops = row + col
        reachable = (hops if hops else 2) <= 3
        assert np.isfinite(tree.node_cost[node_index]) == reachable, node_id


@given(seed=st.integers(0, 2**32 - 1), length_m=st.floats(0.0, 2000.0))
def test_tree_cost_bound_cuts_no_state_within_the_length(seed, length_m):
    """どんな区間の費用（時刻ビンで変わる・割り増し・通れない区間）とターンの待ちでも、実距離`length_m`以内で届く
    状態の木の費用は上界を超えず、上界で打ち切った木はそれらの状態で打ち切らない木と同じになる。上界を
    超えると、帯の中の折返し点が木から落ち、長さの合う周回が出なくなる。"""
    rng = np.random.default_rng(seed)
    lazy, _, structure = build_all(make_grid(6), TURN_SPEC)
    states = structure.state_count
    cost = rng.uniform(0.0, 50.0, (2, states)) * rng.choice([1.0, 10.0], (2, states))
    cost[rng.random((2, states)) < 0.1] = np.inf
    edge_length_m = rng.uniform(1.0, 200.0, states)
    seeds = out_states(lazy, "n0_0")

    def tree(**kwargs):
        return routing.build_turn_expanded_tree(
            structure, cost, edge_length_m, seeds, lazy.node_count,
            edge_seconds=np.ones((2, states)), bin_seconds=30.0, **kwargs,
        )

    full = tree()
    bound = routing.tree_cost_bound(structure, cost, edge_length_m, length_m)
    within = np.isfinite(full.state_cost) & (full.state_length_m <= length_m)
    assert (full.state_cost[within] <= bound).all()
    cut = tree(cost_limit=bound)
    np.testing.assert_array_equal(cut.state_cost[within], full.state_cost[within])


def test_tree_cost_bound_covers_the_waits_and_the_dearest_time_bin():
    """通れる区間が1本の経路に乗る一方通行の折れ線では、上界が経路の費用とちょうど同じになる。ターンの待ちか、
    到達時刻で選ばれる高いほうのビンを見込まない上界は、折れ線の先を打ち切る。曲がる所の待ちは分かれ道にだけ
    付くので、通れない枝を曲がる所ごとに置く。"""
    graph = make_graph(
        {"a": (35.0, 139.0), "b": (35.0, 139.001), "c": (35.001, 139.001), "d": (35.001, 139.002),
         "e": (35.002, 139.002), "bx": (34.999, 139.001), "cx": (35.001, 139.0), "dx": (35.0, 139.002)},
        {"ab": ("a", "b", 100.0, 90.0), "bc": ("b", "c", 100.0, 0.0), "cd": ("c", "d", 100.0, 90.0),
         "de": ("d", "e", 100.0, 0.0), "bx": ("b", "bx", 100.0, 180.0), "cx": ("c", "cx", 100.0, 270.0),
         "dx": ("d", "dx", 100.0, 180.0)},
    )
    lazy, statics, structure = build_all(graph, TURN_SPEC)
    states = state_index(lazy)
    last = states["de"]
    cost = np.full((2, structure.state_count), 10.0)
    cost[:, [states["bx"], states["cx"], states["dx"]]] = np.inf
    cost[1, last] = 100.0
    bound = routing.tree_cost_bound(structure, cost, statics.edge_length_m, 400.0)
    tree = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, out_states(lazy, "a"), lazy.node_count,
        cost_limit=bound, edge_seconds=np.ones((2, structure.state_count)), bin_seconds=1.5,
    )
    assert tree.state_cost[last] == pytest.approx(10.0 * 3 + 100.0 + 2 * TURN_SPEC.left_seconds + TURN_SPEC.right_seconds)


def test_tree_never_enters_a_non_finite_cost_edge():
    """コストinfはHard Constraintの表現。種にも遷移先にもしない（迂回する）。"""
    graph = make_grid(6)
    lazy, statics, structure = build_all(graph)
    cost = np.ones(structure.state_count)
    blocked = state_index(lazy)["n0_0>n0_1"]
    cost[blocked] = np.inf
    tree = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, out_states(lazy, "n0_0"),
        lazy.node_count,
        edge_seconds=np.ones(structure.state_count),
    )
    assert not np.isfinite(tree.state_cost[blocked])
    assert tree.node_cost[lazy.node_id_to_index["n0_1"]] == pytest.approx(3.0)


def test_tree_marks_unreachable_states_and_nodes():
    graph = make_graph(LINE_NODES, LINE_EDGES)
    lazy, statics, structure = build_all(graph)
    cost = np.ones(structure.state_count)
    tree = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, out_states(lazy, "A"),
        lazy.node_count,
        edge_seconds=np.ones(structure.state_count),
    )
    isolated = lazy.node_id_to_index["Z"]
    assert tree.node_cost[isolated] == math.inf
    assert np.isnan(tree.node_length_m[isolated])
    assert routing.turn_expanded_path_edge_indices(tree, isolated) is None


def test_tree_adds_the_turn_wait_to_both_cost_and_seconds():
    """繋ぎ目のターンの待ちは、コストにも所要時間にも入る。"""
    graph = make_graph(PLUS_NODES, PLUS_EDGES)
    lazy, statics, structure = build_all(graph, spec=TURN_SPEC)
    states = state_index(lazy)
    cost = np.ones(structure.state_count)
    seconds = np.full(structure.state_count, 10.0)
    tree = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, np.array([states["WC"]], dtype=np.int64),
        lazy.node_count, edge_seconds=seconds, bin_seconds=1000.0,
    )
    assert tree.state_cost[states["CN"]] == pytest.approx(1.0 + TURN_SPEC.left_seconds + 1.0)
    assert tree.state_seconds[states["CN"]] == pytest.approx(10.0 + TURN_SPEC.left_seconds + 10.0)


def _line_bins():
    """4本の時刻ビン。B→Cのコストだけがビンごとに変わる。"""
    graph = make_graph(LINE_NODES, LINE_EDGES)
    lazy, statics, structure = build_all(graph)
    states = state_index(lazy)
    cost = np.ones((4, structure.state_count))
    for bin_index, value in enumerate([1.0, 7.0, 50.0, 99.0]):
        cost[bin_index, states["BC"]] = value
    seconds = np.full((4, structure.state_count), 10.0)
    return lazy, statics, structure, states, cost, seconds


@pytest.mark.parametrize(
    ("bin_seconds", "expected"),
    [
        (5.0, 1.0 + 50.0),
        (2.0, 1.0 + 99.0),  # 予報の窓より長くかかる経路は、最後のビンの条件で評価を続ける
    ],
)
def test_tree_picks_the_time_bin_by_elapsed_seconds(bin_seconds, expected):
    """時計を進めるのは素の所要時間であってコストではない。ビンの幅で引かれる行が変わる。"""
    lazy, statics, structure, states, cost, seconds = _line_bins()
    tree = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, np.array([states["AB"]], dtype=np.int64),
        lazy.node_count, edge_seconds=seconds, bin_seconds=bin_seconds,
    )
    assert tree.state_cost[states["BC"]] == pytest.approx(expected)


def test_reverse_tree_measures_the_cost_from_each_state_to_the_destination():
    """逆向きの木は遷移の向きだけを反転する。Nodeのコストは「そのNodeから出て目的地まで」。"""
    graph = make_graph(LINE_NODES, LINE_EDGES)
    lazy, statics, structure = build_all(graph)
    states = state_index(lazy)
    tree = routing.build_turn_expanded_tree(
        structure, np.ones(structure.state_count), statics.edge_length_m,
        np.array([states["BC"]], dtype=np.int64), lazy.node_count, reverse=True,
        edge_seconds=np.ones(structure.state_count),
    )
    assert tree.state_cost[states["AB"]] == pytest.approx(2.0)
    assert tree.node_cost[lazy.node_id_to_index["A"]] == pytest.approx(2.0)
    assert tree.node_length_m[lazy.node_id_to_index["A"]] == pytest.approx(200.0)


def test_reverse_tree_rejects_time_bins():
    """逆向きの木には到達時刻が無い。ビンを渡せば時刻が反転した条件で評価した経路が返るため送出する。"""
    lazy, statics, structure, states, cost, seconds = _line_bins()
    with pytest.raises(ValueError):
        routing.build_turn_expanded_tree(
            structure, cost, statics.edge_length_m, np.array([states["BC"]], dtype=np.int64),
            lazy.node_count, reverse=True, edge_seconds=seconds, bin_seconds=5.0,
        )


# --- 経路の復元 ---


def test_forward_path_runs_from_the_tree_source_to_the_state():
    graph = make_graph(LINE_NODES, LINE_EDGES)
    lazy, statics, structure = build_all(graph)
    states = state_index(lazy)
    tree = routing.build_turn_expanded_tree(
        structure, np.ones(structure.state_count), statics.edge_length_m,
        np.array([states["AB"]], dtype=np.int64), lazy.node_count,
        edge_seconds=np.ones(structure.state_count),
    )
    assert routing.turn_expanded_path_from_state(tree, states["BC"]) == [states["AB"], states["BC"]]
    assert routing.turn_expanded_path_edge_indices(tree, lazy.node_id_to_index["C"]) == [
        states["AB"], states["BC"],
    ]


def test_backward_path_is_already_in_travel_order():
    """逆向きの木では、前任者を辿ることが目的地へ近づくことに当たるため反転しない。"""
    graph = make_graph(LINE_NODES, LINE_EDGES)
    lazy, statics, structure = build_all(graph)
    states = state_index(lazy)
    tree = routing.build_turn_expanded_tree(
        structure, np.ones(structure.state_count), statics.edge_length_m,
        np.array([states["BC"]], dtype=np.int64), lazy.node_count, reverse=True,
        edge_seconds=np.ones(structure.state_count),
    )
    assert routing.turn_expanded_path_from_state_to_source(tree, states["AB"]) == [
        states["AB"], states["BC"],
    ]


# --- 木の経路どうしの重複率 ---


@given(st.lists(st.floats(0.5, 5.0), min_size=60, max_size=60), st.lists(st.integers(0, 15), min_size=1, max_size=4))
def test_tree_path_overlap_measures_what_the_edge_sets_of_the_paths_share(costs, accepted_nodes):
    """木の経路どうしの重複率は、経路の区間の集合で測った割合（`overlap_ratio`）と同じ。ずれると、周回の折返し点の
    間引きが同じ道筋の往路を通したり、別の道筋の往路を弾いたりする。費用を揺らして木の枝分かれを変える。"""
    lazy, statics, structure = build_all(make_grid(4))
    cost = np.resize(np.asarray(costs), structure.state_count)
    tree = routing.build_turn_expanded_tree(
        structure, cost, cost * 100.0, out_states(lazy, "n1_1"), lazy.node_count, edge_seconds=cost,
    )
    overlap = routing.TreePathOverlap(tree)
    accepted_paths = []
    for node in accepted_nodes:
        overlap.accept(node)
        accepted_paths.append(np.asarray(routing.turn_expanded_path_edge_indices(tree, node)))
        for candidate in range(lazy.node_count):
            path = np.asarray(routing.turn_expanded_path_edge_indices(tree, candidate))
            expected = max(route_diversity.overlap_ratio(path, other, cost * 100.0) for other in accepted_paths)
            assert overlap.max_ratio(candidate) == pytest.approx(expected)


# --- combine_forward_backward_at_nodes ---


def test_junction_includes_the_turn_cost_at_the_meeting_node():
    """Nodeで前後の木を足すだけだと、そこを通り抜けるターンの費用が抜ける。"""
    graph = make_graph(PLUS_NODES, PLUS_EDGES)
    lazy, statics, structure = build_all(graph, spec=TURN_SPEC)
    states = state_index(lazy)
    cost = np.ones(structure.state_count)
    forward = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, np.array([states["WC"]], dtype=np.int64),
        lazy.node_count,
        edge_seconds=np.ones(structure.state_count),
    )
    backward = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, np.array([states["CN"]], dtype=np.int64),
        lazy.node_count, reverse=True,
        edge_seconds=np.ones(structure.state_count),
    )
    junction = routing.combine_forward_backward_at_nodes(
        structure, forward, backward, lazy.node_count
    )
    center = lazy.node_id_to_index["C"]
    assert junction.cost[center] == pytest.approx(1.0 + TURN_SPEC.left_seconds + 1.0)
    assert junction.forward_state[center] == states["WC"]
    assert junction.backward_state[center] == states["CN"]
    assert junction.length_m[center] == pytest.approx(200.0)


def test_junction_leaves_unreachable_nodes_empty():
    graph = make_graph(LINE_NODES, LINE_EDGES)
    lazy, statics, structure = build_all(graph)
    states = state_index(lazy)
    cost = np.ones(structure.state_count)
    node_count = lazy.node_count
    forward = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, np.array([states["AB"]], dtype=np.int64), node_count,
        edge_seconds=np.ones(structure.state_count),
    )
    backward = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, np.array([states["BC"]], dtype=np.int64),
        node_count, reverse=True,
        edge_seconds=np.ones(structure.state_count),
    )
    junction = routing.combine_forward_backward_at_nodes(structure, forward, backward, node_count)
    isolated = lazy.node_id_to_index["Z"]
    assert junction.cost[isolated] == math.inf
    assert np.isnan(junction.length_m[isolated])
    assert junction.forward_state[isolated] == -1
    assert junction.backward_state[isolated] == -1


# --- 時刻ビンの契約 ---


@pytest.mark.parametrize(
    ("shape", "expected"),
    [
        ((3,), (1, 3)),  # 1次元は時刻に依存しないビン1本
        ((3, 4), (3, 4)),
    ],
)
def test_cost_and_seconds_are_shaped_as_time_bins_by_states(shape, expected):
    cost_bins, seconds_bins = routing.time_bin_arrays("caller", np.ones(shape), np.ones(shape), 60.0)
    assert cost_bins.shape == expected
    assert seconds_bins.shape == expected


def test_more_than_two_dimensions_is_refused():
    """黙って(1, n)へ潰すと、ビン数の食い違いの検査もすり抜けてJITが範囲外を読む。"""
    with pytest.raises(ValueError):
        routing.time_bin_arrays("caller", np.ones((2, 3, 4)), np.ones((2, 3, 4)), 60.0)


@pytest.mark.parametrize("bin_seconds", [0.0, math.inf])
def test_time_binned_cost_requires_a_positive_finite_bin_width(bin_seconds):
    """幅が無いと全区間が先頭のビンへ落ち、例外もNaNも出ないまま結果だけが変わる。"""
    with pytest.raises(ValueError):
        routing.time_bin_arrays("caller", np.ones((2, 3)), np.ones((2, 3)), bin_seconds)


def test_mismatched_cost_and_seconds_shapes_raise():
    """JITした探索は境界を検査しない。ビン数が食い違えば範囲外の読み出しになる。"""
    with pytest.raises(ValueError):
        routing.time_bin_arrays("caller", np.ones((2, 3)), np.ones((2, 4)), 60.0)


# --- turn_expanded_shortest_path ---


def test_shortest_path_returns_edge_indices_in_travel_order():
    """格子の対角へは、区間コストが一様なら最小ホップ数ぶんの区間を通る。"""
    graph = make_grid(GRID_SIZE)
    last = GRID_SIZE - 1
    goal = f"n{last}_{last}"
    lazy, _, structure = build_all(graph)
    path = routing.turn_expanded_shortest_path(
        structure, np.ones(structure.state_count),
        np.zeros(lazy.node_count), out_states(lazy, "n0_0"),
        lazy.node_id_to_index[goal],
        edge_seconds=np.ones(structure.state_count),
    )
    assert path is not None
    assert len(path) == last * 2
    assert graph.edges[lazy.edge_ids[path[0]]].from_node_id == "n0_0"
    assert graph.edges[lazy.edge_ids[path[-1]]].to_node_id == goal
    hops = [lazy.edge_ids[index] for index in path]
    assert all(
        graph.edges[a].to_node_id == graph.edges[b].from_node_id for a, b in zip(hops, hops[1:])
    )


def test_shortest_path_ignores_non_finite_costs_among_seeds_and_successors():
    """コストinfの区間は、起点から出る区間としても遷移先としても通らない。"""
    graph = make_graph(PLUS_NODES, PLUS_EDGES)
    lazy, _, structure = build_all(graph)
    states = state_index(lazy)
    cost = np.ones(structure.state_count)
    cost[states["CW"]] = np.inf
    cost[states["CE"]] = 3.0
    cost[states["CN"]] = 1.0
    cost[states["CS"]] = 2.0
    path = routing.turn_expanded_shortest_path(
        structure, cost, np.zeros(lazy.node_count), out_states(lazy, "C"),
        lazy.node_id_to_index["E"],
        edge_seconds=np.ones(structure.state_count),
    )
    assert path == [states["CE"]]


def test_shortest_path_is_none_when_the_goal_cannot_be_reached():
    graph = make_graph(LINE_NODES, LINE_EDGES)
    lazy, _, structure = build_all(graph)
    states = state_index(lazy)
    path = routing.turn_expanded_shortest_path(
        structure, np.ones(structure.state_count), np.zeros(lazy.node_count),
        np.array([states["AB"]], dtype=np.int64), lazy.node_id_to_index["Z"],
        edge_seconds=np.ones(structure.state_count),
    )
    assert path is None


# AからCへ、北のBを回る道と南のDを回る道。BとDには、まっすぐ抜ける行き止まりの道（E・F）が分かれる。
FORK_NODES = {
    "A": (35.00, 139.00),
    "B": (35.01, 139.01),
    "D": (34.99, 139.01),
    "C": (35.00, 139.02),
    "E": (35.02, 139.02),
    "F": (34.98, 139.02),
}
FORK_EDGES = {
    "AB": ("A", "B", 100.0, 45.0),
    "BA": ("B", "A", 100.0, 225.0),
    "BC": ("B", "C", 100.0, 135.0),
    "CB": ("C", "B", 100.0, 315.0),
    "AD": ("A", "D", 100.0, 135.0),
    "DA": ("D", "A", 100.0, 315.0),
    "DC": ("D", "C", 100.0, 45.0),
    "CD": ("C", "D", 100.0, 225.0),
    "BE": ("B", "E", 100.0, 45.0),
    "EB": ("E", "B", 100.0, 225.0),
    "DF": ("D", "F", 100.0, 135.0),
    "FD": ("F", "D", 100.0, 315.0),
}


def test_shortest_path_pays_for_turns_not_only_for_edges():
    """右折より左折が高い較正では、区間コストが安い方でも曲がりの高い経路は選ばれない。"""
    graph = make_graph(FORK_NODES, FORK_EDGES)
    lazy, _, structure = build_all(graph, spec=TURN_SPEC)
    states = state_index(lazy)
    cost = np.ones(structure.state_count)
    cost[states["BC"]] = 2.0
    path = routing.turn_expanded_shortest_path(
        structure, cost, np.zeros(lazy.node_count),
        out_states(lazy, "A"), lazy.node_id_to_index["C"],
        edge_seconds=np.ones(structure.state_count),
    )
    assert path == [states["AB"], states["BC"]]


@pytest.mark.parametrize(("bin_seconds", "expected_middle"), [(20.0, "B"), (5.0, "D")])
def test_shortest_path_reads_the_cost_of_the_bin_it_arrives_in(bin_seconds, expected_middle):
    """出発からの経過時間でビンが変わると、同じ入力でも通る経路が変わる。"""
    graph = make_graph(FORK_NODES, FORK_EDGES)
    lazy, _, structure = build_all(graph)
    states = state_index(lazy)
    cost = np.ones((2, structure.state_count))
    cost[0, states["DC"]] = 100.0
    cost[1, states["BC"]] = 100.0
    seconds = np.full((2, structure.state_count), 10.0)
    path = routing.turn_expanded_shortest_path(
        structure, cost, np.zeros(lazy.node_count), out_states(lazy, "A"),
        lazy.node_id_to_index["C"], edge_seconds=seconds, bin_seconds=bin_seconds,
    )
    assert path is not None
    assert graph.edges[lazy.edge_ids[path[0]]].to_node_id == expected_middle


# --- 優先度キューの伸長 ---


@pytest.mark.parametrize("carries_g", [True, False])
def test_heap_returns_every_entry_in_key_order_across_growth(carries_g):
    """容量1から何度も伸ばしても、積んだエントリを1件も欠かさずキーの昇順で返す。

    `g`の列を持つヒープは積んだ`g`をそのまま、持たないヒープはキーを`g`として返す。
    `g`の列を持つヒープは、伸ばした後も全列が要素数以上の長さを持つ（JITは配列の境界を
    検査しないため、1列だけ伸ばし忘れても出力からは見えないことがある）。
    """
    keys = np.random.default_rng(0).permutation(50).astype(float)
    heap = routing.empty_heap(1, carries_g)
    size = 0
    for state, key in enumerate(keys):
        if carries_g:
            heap, size = routing.heap_push(heap, size, key, state, key * 10.0 + 0.5)
        else:
            heap, size = routing.heap_push(heap, size, key, state)
    columns = heap[:3] if carries_g else heap[:2]
    assert all(column.shape[0] >= size for column in columns)
    popped = []
    while size > 0:
        g, state, size = routing.heap_pop(heap, size)
        popped.append((keys[state], g))
    assert [key for key, _ in popped] == sorted(keys)
    assert [g for _, g in popped] == [key * 10.0 + 0.5 if carries_g else key for key, _ in popped]


# 扇の葉の数。起点から出る区間は1本なので、優先度キューの初期容量は1＋`HEAP_INITIAL_SLACK`。
# 分岐Hを取り出した1回の展開で葉へ出る区間が全部積まれるため、容量を超えて何度も伸びる。
FAN_SPOKES = routing.HEAP_INITIAL_SLACK * 4


def make_fan():
    """起点O→分岐H→葉`L0`…の扇。各葉から終点Gへ1本ずつ入る（逆向きの区間は無い）。"""
    nodes = {"O": (35.00, 139.00), "H": (35.00, 139.01), "G": (35.00, 139.03)}
    edges = {"OH": ("O", "H")}
    for spoke in range(FAN_SPOKES):
        nodes[f"L{spoke}"] = (35.00 + (spoke - FAN_SPOKES / 2) * 0.0001, 139.02)
        edges[f"HL{spoke}"] = ("H", f"L{spoke}")
        edges[f"L{spoke}G"] = (f"L{spoke}", "G")
    return make_graph(nodes, edges)


def test_shortest_path_stays_exact_while_the_queue_grows():
    """伸長をまたいでも、A*は唯一の最安経路（葉`L0`を通る）を返す。

    `L0`の下界を0でなくし、キー（`g`＋下界）と`g`を別の値にする——取り出しがキーを`g`として返すと、
    `L0`を通る経路が下界の分だけ高く見え、次に安い`L1`を通る経路が選ばれる。
    `g`の列そのものが伸長で崩れないことは、部品のテスト（上）が見る。
    """
    graph = make_fan()
    lazy, _, structure = build_all(graph)
    states = state_index(lazy)
    cost = np.ones(structure.state_count)
    for spoke in range(FAN_SPOKES):
        cost[states[f"L{spoke}G"]] = 10.0
    cost[states["L0G"]] = 2.0
    cost[states["L1G"]] = 3.0
    heuristic = np.zeros(lazy.node_count)
    heuristic[lazy.node_id_to_index["L0"]] = 2.0
    path = routing.turn_expanded_shortest_path(
        structure, cost, heuristic, out_states(lazy, "O"), lazy.node_id_to_index["G"],
        edge_seconds=np.ones(structure.state_count),
    )
    assert path == [states["OH"], states["HL0"], states["L0G"]]


# --- 探索のJITの型 ---


def test_searches_compile_nothing_after_baking_whatever_arrays_the_caller_passes():
    """イメージの組み立てで焼いたコンパイル結果（`compile_search_kernels`）は、型の同じ呼び出しにしか効かない。
    探索の入口が型を揃えるため、呼び出し側の配列のdtype・並び・読み取り専用かに依らず、焼いた後の探索は
    コンパイルしない——本番の最初のルート生成がコンパイルを払わない。

    コンパイルはnumbaの出来事（`numba:compile`）で数える。ディスクのキャッシュから読んだ型は出来事を出さないが、
    キャッシュは`routing.py`を書き換えると無効になるため、型を揃え損ねた変更は最初の実行でここに出る。"""
    if numba.config.DISABLE_JIT:
        pytest.skip("JITを切って測っている（numbaの型がそもそも無い）")
    routing.compile_search_kernels()
    lazy, statics, structure = build_all(make_grid(3))
    state_count = structure.state_count
    read_only = np.ones((2, state_count))
    read_only.flags.writeable = False
    costs = [
        np.ones(state_count, dtype=np.float32),
        np.ones((state_count, 2)).T,  # C順でない
        read_only,
    ]
    origin_states = out_states(lazy, "n0_0").astype(np.int32)
    with event.install_recorder("numba:compile") as compiled:
        for cost in costs:
            routing.build_turn_expanded_tree(
                structure, cost, statics.edge_length_m.astype(np.float32), origin_states, lazy.node_count,
                edge_seconds=cost, bin_seconds=3600.0,
            )
            routing.turn_expanded_shortest_path(
                structure, cost, np.zeros(lazy.node_count, dtype=np.float32), origin_states,
                lazy.node_id_to_index["n2_2"], edge_seconds=cost, bin_seconds=3600.0,
            )
        routing.build_turn_expanded_tree(
            structure, costs[0], statics.edge_length_m, origin_states, lazy.node_count,
            reverse=True, edge_seconds=costs[0],
        )

    assert compiled.buffer == []


async def test_route_generation_calls_from_python_only_the_jit_that_the_image_bakes(monkeypatch):
    """イメージに焼くのは`compile_search_kernels`がPythonから呼ぶJITだけ。生成の経路がPythonからそれ以外のJIT
    （探索の中へ展開する部品等）を呼ぶと、コンテナの最初の生成がそのコンパイルを払う。

    `app`の全モジュールが持つJITの関数を、Pythonからの呼び出しを記録する包みへ差し替えて数える。探索の中から
    の呼び出しはコンパイル済みの本体どうしで結ばれ、包みを通らない。"""
    if numba.config.DISABLE_JIT:
        pytest.skip("JITを切って測っている（numbaの型がそもそも無い）")
    routing.compile_search_kernels()  # 包む前に本体を用意する（包んだ後にコンパイルすると、部品の代わりに包みを読む）
    called: set[str] = set()

    def recording(name, dispatcher):
        def call(*args, **kwargs):
            called.add(name)
            return dispatcher(*args, **kwargs)
        return call

    for module in [m for name, m in sys.modules.items() if name == "app" or name.startswith("app.")]:
        for attr, value in list(vars(module).items()):
            if isinstance(value, CPUDispatcher):
                monkeypatch.setattr(module, attr, recording(value.py_func.__qualname__, value))
    routing.compile_search_kernels()
    baked, called = called, set()

    times = [datetime(2026, 9, 22, h) for h in range(24)]
    speed = np.full((4, len(times)), 3.0)
    wind = WindForecastSeries(
        times=times, speed_ms=speed, direction_deg=np.zeros_like(speed),
        lattice=MsmBlock(
            grid=MsmGrid(lat_min=BASE_LAT, lon_min=BASE_LON, d_lat=0.018, d_lon=0.022, n_lat=2, n_lon=2), row0=0, col0=0, rows=2, cols=2,
        ),
    )
    with avoid_axis_declared():
        generator = generator_for(monkeypatch, grid_network(), 0.0, wind)
        departure = datetime(2026, 9, 22, 8, tzinfo=timezone(timedelta(hours=9)))
        assert await generator.generate_loops(
                at(CENTER), 4.0, 1.5, points=NO_POINTS, max_routes=3, start_time=departure)
        assert await generator.generate_via_waypoints(
            at(SOUTH_WEST), [], destination=at(NORTH_EAST), max_routes=3, start_time=departure)

    assert called and called <= baked
