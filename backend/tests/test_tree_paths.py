"""`app/domain/tree_paths.py`——一対全の木から経路を取り出す・測る・繋ぐ。

見るもの: 前向き木の経路の復元、木の経路どうしの重複率、前向き木と後ろ向き木の繋ぎ目とそこで継いだ経路の選定。

ここで見ないもの:
- 木そのものの費用・時刻ビン → `test_routing.py`
- 候補の間引きの手順（`select_diverse_by_overlap`） → `test_route_diversity.py`
"""
import math

import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain import route_diversity, routing, tree_paths
from app.domain.turn_structure import turn_search_seconds
from tests.search_graph_world import (
    LINE_EDGES,
    LINE_NODES,
    PLUS_EDGES,
    PLUS_NODES,
    TURN_SPEC,
    build_all,
    make_graph,
    make_grid,
    out_states,
    state_index,
)


# --- 経路の復元 ---


def test_forward_path_runs_from_the_tree_source_to_the_state():
    graph = make_graph(LINE_NODES, LINE_EDGES)
    lazy, statics, structure = build_all(graph)
    states = state_index(lazy)
    tree = routing.build_turn_expanded_tree(
        structure, np.ones(structure.state_count), statics.edge_length_m,
        np.array([states["AB"]], dtype=np.int64), lazy.node_count,
        edge_seconds=np.ones(structure.state_count), transition_cost=structure.turn_seconds
    )
    assert tree_paths.turn_expanded_path_from_state(tree, states["BC"]) == [states["AB"], states["BC"]]
    assert tree_paths.turn_expanded_path_edge_indices(tree, lazy.node_id_to_index["C"]) == [
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
        structure, cost, cost * 100.0, out_states(lazy, "n1_1"), lazy.node_count, edge_seconds=cost, transition_cost=structure.turn_seconds
    )
    overlap = tree_paths.TreePathOverlap(tree)
    accepted_paths = []
    for node in accepted_nodes:
        overlap.accept(node)
        accepted_paths.append(np.asarray(tree_paths.turn_expanded_path_edge_indices(tree, node)))
        for candidate in range(lazy.node_count):
            path = np.asarray(tree_paths.turn_expanded_path_edge_indices(tree, candidate))
            expected = max(route_diversity.overlap_ratio(path, other, cost * 100.0) for other in accepted_paths)
            assert overlap.max_ratio(candidate) == pytest.approx(expected)


# --- combine_forward_backward_at_nodes ---


def test_junction_includes_the_turn_cost_at_the_meeting_node():
    """Nodeで前後の木を足すだけだと、そこを通り抜けるターンの費用が抜ける。"""
    graph = make_graph(PLUS_NODES, PLUS_EDGES)
    lazy, statics, structure = build_all(graph, spec=TURN_SPEC)
    states = state_index(lazy)
    cost = np.ones(structure.state_count)
    transition = turn_search_seconds(structure, TURN_SPEC)
    forward = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, np.array([states["WC"]], dtype=np.int64),
        lazy.node_count,
        edge_seconds=np.ones(structure.state_count), transition_cost=transition
    )
    backward = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, np.array([states["CN"]], dtype=np.int64),
        lazy.node_count, reverse=True,
        edge_seconds=np.ones(structure.state_count), transition_cost=transition
    )
    junction = tree_paths.combine_forward_backward_at_nodes(
        structure, forward, backward, lazy.node_count, transition_cost=transition
    )
    center = lazy.node_id_to_index["C"]
    assert junction.cost[center] == pytest.approx(1.0 + TURN_SPEC.slow_left.expected_seconds + 1.0)
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
        edge_seconds=np.ones(structure.state_count), transition_cost=structure.turn_seconds
    )
    backward = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, np.array([states["BC"]], dtype=np.int64),
        node_count, reverse=True,
        edge_seconds=np.ones(structure.state_count), transition_cost=structure.turn_seconds
    )
    junction = tree_paths.combine_forward_backward_at_nodes(structure, forward, backward, node_count, transition_cost=structure.turn_seconds)
    isolated = lazy.node_id_to_index["Z"]
    assert junction.cost[isolated] == math.inf
    assert np.isnan(junction.length_m[isolated])
    assert junction.forward_state[isolated] == -1
    assert junction.backward_state[isolated] == -1


@pytest.mark.parametrize("seed", range(3))
def test_tree_and_junction_keep_per_node_the_cheapest_and_on_a_tie_the_lowest_numbered(seed):
    """木はNodeごとに費用の最小の状態を、繋ぎ目は合計の最小の遷移を採り、同じ費用なら番号の小さいものを残す。

    費用を小さな整数にして同じ費用を多く作り、各Nodeの期待を（費用, 番号）の辞書順の最小として総当たりで出す。"""
    lazy, statics, structure = build_all(make_grid(5))
    rng = np.random.default_rng(seed)
    cost = rng.integers(1, 3, structure.state_count).astype(np.float64)
    transition_cost = rng.integers(0, 2, len(structure.target_state)).astype(np.float32)
    seconds = np.ones(structure.state_count)
    forward = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, out_states(lazy, "n0_0"), lazy.node_count,
        edge_seconds=seconds, transition_cost=transition_cost,
    )
    destination = lazy.node_id_to_index["n4_4"]
    backward = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, np.flatnonzero(lazy.graph.edge_to == destination), lazy.node_count,
        reverse=True, edge_seconds=seconds, transition_cost=transition_cost,
    )
    junction = tree_paths.combine_forward_backward_at_nodes(
        structure, forward, backward, lazy.node_count, transition_cost=transition_cost
    )

    def cheapest_lowest_numbered(node_of_item, item_cost):
        """Nodeごとの（費用, 番号）の最小の番号と、最小の費用に並んだ番号の数の最大。"""
        expected = np.full(lazy.node_count, -1)
        tied = 0
        for node in range(lazy.node_count):
            items = [i for i in np.flatnonzero(node_of_item == node) if np.isfinite(item_cost[i])]
            if items:
                expected[node] = min(items, key=lambda i: (item_cost[i], i))
                tied = max(tied, sum(item_cost[i] == item_cost[expected[node]] for i in items))
        return expected, tied

    for tree, node_of_state in ((forward, structure.edge_to), (backward, structure.edge_from)):
        expected, tied = cheapest_lowest_numbered(node_of_state, tree.state_cost)
        assert tied > 1  # 同じ費用の状態が並ぶNodeがある
        assert np.array_equal(tree.node_best_state, expected)

    source = np.repeat(np.arange(structure.state_count), np.diff(structure.indptr))
    target = structure.target_state
    total = forward.state_cost[source] + transition_cost + backward.state_cost[target]
    picked, tied = cheapest_lowest_numbered(structure.edge_to[source], total)
    assert tied > 1  # 同じ合計の遷移が並ぶNodeがある
    joined = picked >= 0
    assert np.array_equal(junction.forward_state[joined], source[picked[joined]])
    assert np.array_equal(junction.backward_state[joined], target[picked[joined]])
    assert np.array_equal(junction.cost[joined], total[picked[joined]])
    assert np.all(junction.forward_state[~joined] == -1)
    assert np.all(np.isinf(junction.cost[~joined]))


# --- 木を継いだ経路の取り出しと選定 ---

JUNCTION_OVERLAP_RATIOS = [0.3, 0.6]


def _python_walk(predecessor, state):
    edges = []
    while state >= 0:
        edges.append(int(state))
        state = int(predecessor[state])
    return edges


class _SetOverlap:
    """採用済みの経路ごとに`overlap_ratio`を測り直す素直な重複率（比べる相手）。測った値を残す。"""

    def __init__(self, paths, edge_length_m):
        self._paths, self._edge_length_m, self._accepted, self.ratios = paths, edge_length_m, [], []

    def max_ratio(self, node):
        path = self._paths[node]
        if path is None:
            return None
        ratio = max(
            (route_diversity.overlap_ratio(np.asarray(path), np.asarray(other), self._edge_length_m)
             for other in self._accepted),
            default=0.0,
        )
        self.ratios.append(ratio)
        return ratio

    def accept(self, node):
        self._accepted.append(self._paths[node])


def _junction_selection(costs):
    """4×4の格子の隅から対角の隅へ、全Nodeを経由の候補として番号順に選んだ結果を、`JunctionPaths`と素直な書き方の両方で
    求める。素直な書き方は、前任者をPythonで辿り、両側の区間を両端のNodeのfrozensetにして重なりを見る。"""
    lazy, statics, structure = build_all(make_grid(4))
    cost = np.resize(np.asarray(costs), structure.state_count)
    edge_length_m = cost * 100.0
    destination = lazy.node_id_to_index["n3_3"]
    forward = routing.build_turn_expanded_tree(
        structure, cost, edge_length_m, out_states(lazy, "n0_0"), lazy.node_count, edge_seconds=cost,
        transition_cost=structure.turn_seconds,
    )
    backward = routing.build_turn_expanded_tree(
        structure, cost, edge_length_m, np.flatnonzero(lazy.graph.edge_to == destination), lazy.node_count,
        reverse=True, edge_seconds=cost, transition_cost=structure.turn_seconds,
    )
    junction = tree_paths.combine_forward_backward_at_nodes(
        structure, forward, backward, lazy.node_count, transition_cost=structure.turn_seconds,
    )
    tree_paths.add_terminal_candidate(junction, forward, destination)
    paths = tree_paths.JunctionPaths(junction, forward, backward, lazy.graph.edge_from, lazy.graph.edge_to)

    def segments(path):
        return {frozenset({int(lazy.graph.edge_from[e]), int(lazy.graph.edge_to[e])}) for e in path}

    reference = {}
    for node in range(lazy.node_count):
        forward_state, backward_state = int(junction.forward_state[node]), int(junction.backward_state[node])
        if forward_state < 0:
            reference[node] = None
            continue
        halves = (
            _python_walk(forward.predecessor, forward_state)[::-1],
            _python_walk(backward.predecessor, backward_state),
        )
        reference[node] = None if segments(halves[0]) & segments(halves[1]) else halves
    measure = _SetOverlap({node: found and found[0] + found[1] for node, found in reference.items()}, edge_length_m)
    expected = route_diversity.select_diverse_by_overlap(range(lazy.node_count), measure, JUNCTION_OVERLAP_RATIOS, 4)
    selected = route_diversity.select_diverse_by_overlap(
        range(lazy.node_count), route_diversity.EdgeSetOverlap(paths.edges, edge_length_m, 4), JUNCTION_OVERLAP_RATIOS, 4,
    )
    return (
        [paths.halves(node) for node in selected], [reference[node] for node in expected],
        sum(found is None for found in reference.values()), measure.ratios,
    )


@given(st.lists(st.floats(0.5, 5.0), min_size=48, max_size=48))
def test_junction_paths_pick_the_same_via_routes_as_walking_the_trees_in_python(costs):
    """目的地ルートの代わりの道は、継いだ経路が行って戻る形のNodeを除き、採用済みと重なりすぎる候補を飛ばして選ぶ。
    前任者を辿るのと重なりを測るのをJITへ移しても、選ぶNodeと順・経路は素直な書き方と同じでなければ、候補の道が変わる。"""
    actual, expected, _, _ = _junction_selection(costs)
    assert actual == expected


def test_junction_selection_example_covers_retraced_and_overlapping_candidates():
    """上の比べ合いが、行って戻る形のNodeと重なりで飛ばす候補の両方を通る入力で成り立つ。"""
    actual, expected, retraced, ratios = _junction_selection([1.0] * 48)
    assert actual == expected
    assert retraced > 0
    assert max(ratios) > JUNCTION_OVERLAP_RATIOS[-1]
