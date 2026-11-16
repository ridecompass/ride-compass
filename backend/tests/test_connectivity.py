"""`app/domain/connectivity.py`——置いた点を寄せてよいノードと、来た道を戻らずに行き来できるノード。

ここで見ないもの:
- 探索用グラフ（CSR）の組み立て → `test_search_graph.py`
"""
import numpy as np
from hypothesis import example, given
from hypothesis import strategies as st

from app.domain import connectivity, search_graph


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

    found = connectivity.largest_strongly_connected_nodes(statics.csr, passable)

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
    within = connectivity.largest_strongly_connected_nodes(statics.csr, passable)
    inside = np.flatnonzero(within).tolist()
    terminals = [inside[pick % len(inside)] for pick in terminal_picks]

    found = connectivity.nodes_reached_without_retracing(statics.csr, passable, within, terminals)

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
