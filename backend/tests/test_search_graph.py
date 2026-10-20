"""`app/domain/search_graph.py`——探索用グラフとCSRの組み立て。

見るもの: 並行区間の解消、区間の番号順の距離、CSRの行の並び、両端のノードから区間を引くこと。

ここで見ないもの:
- ターンの遷移と秒 → `test_turn_structure.py`。探索 → `test_routing.py`
- 道路網全体の配列の作り方・範囲の切り出し → `test_road_network*.py`
- 区間が0本の探索用グラフ → 本番では作らない（道の無い範囲は`services/road_graph_engine.py`が組む前に返す）
"""
from app.domain import search_graph
from tests.search_graph_world import (
    LINE_EDGES,
    LINE_NODES,
    ONE_WAY_EDGES,
    ONE_WAY_NODES,
    PLUS_EDGES,
    PLUS_NODES,
    lazy_of,
    make_graph,
)

# --- build_lazy_road_graph ---


def test_parallel_edges_resolve_to_the_lowest_row():
    """同一Node対に複数の区間があるとき、採用されるのは元の行が最も小さい1本。

    ここが並べ替えの揺れに依ると、同じ範囲・同じ設定でも呼ぶたびに別の区間が探索へ出て、
    返るルートが揺れる。
    """
    graph = make_graph(
        {"a": (35.0, 139.0), "b": (35.0, 139.01)},
        {"first": ("a", "b"), "second": ("a", "b"), "third": ("a", "b")},
    )
    assert lazy_of(graph).edge_ids == ["first"]


# --- build_search_graph_statics ---


def test_statics_carry_edge_length_in_edge_number_order():
    edges = dict(LINE_EDGES)
    edges["AB"] = ("A", "B", 250.0, 90.0)
    edges["BC"] = ("B", "C", 70.0, 90.0)
    graph = make_graph(LINE_NODES, edges)
    lazy = lazy_of(graph)
    statics = search_graph.build_search_graph_statics(lazy.graph, graph.distance_m)
    expected = [graph.edges[edge_id].distance_m for edge_id in lazy.edge_ids]
    assert list(statics.edge_length_m) == expected


def test_csr_rows_hold_the_outgoing_edges_of_each_node_in_ascending_order():
    """CSRの行は「そのNodeから出る区間」で、entry_edge_index経由で区間へ戻れる。
    行内の遷移先Nodeは昇順（探索の隣接走査と`edge_index_between`がこの並びを前提にする）。"""
    graph = make_graph(PLUS_NODES, PLUS_EDGES)
    lazy = lazy_of(graph)
    csr = search_graph.build_search_graph_statics(lazy.graph, graph.distance_m).csr
    for node_id, node_index in lazy.node_id_to_index.items():
        start, end = int(csr.indptr[node_index]), int(csr.indptr[node_index + 1])
        row = [(int(csr.indices[k]), lazy.edge_ids[int(csr.entry_edge_index[k])]) for k in range(start, end)]
        assert [to_index for to_index, _ in row] == sorted(to_index for to_index, _ in row)
        recovered = {
            (lazy.index_to_node_id[to_index], edge_id) for to_index, edge_id in row
        }
        expected = {
            (edge.to_node_id, edge_id)
            for edge_id, edge in graph.edges.items()
            if edge.from_node_id == node_id
        }
        assert recovered == expected


# --- edge_index_between ---


def test_edge_between_finds_each_direction_and_nothing_where_no_road_runs():
    """両端のノードから区間の番号を引く。一方通行の逆向きや繋がっていない対はNone。"""
    graph = make_graph(ONE_WAY_NODES, ONE_WAY_EDGES)
    lazy = lazy_of(graph)
    csr = search_graph.build_search_graph_statics(lazy.graph, graph.distance_m).csr
    node = lazy.node_id_to_index
    for edge_id, edge in graph.edges.items():
        found = search_graph.edge_index_between(csr, node[edge.from_node_id], node[edge.to_node_id])
        assert found is not None and lazy.edge_ids[found] == edge_id
    assert search_graph.edge_index_between(csr, node["N"], node["C"]) is None
    assert search_graph.edge_index_between(csr, node["N"], node["E"]) is None
