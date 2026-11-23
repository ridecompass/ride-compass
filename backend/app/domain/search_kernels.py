"""探索のJITを、イメージの組み立てで焼く。"""
import numpy as np
from app.domain.connectivity import largest_strongly_connected_nodes, nodes_reached_without_retracing
from app.domain.leg_costs import compile_leg_cost_kernels
from app.domain.route_diversity import EdgeSetOverlap
from app.domain.routing import build_turn_expanded_tree, turn_expanded_shortest_path
from app.domain.search_graph import build_lazy_road_graph, build_search_graph_statics
from app.domain.tree_paths import JunctionPaths, TreePathOverlap, combine_forward_backward_at_nodes
from app.domain.tuning import TUNING_PARAMETERS_BY_ID, Tuning
from app.domain.turn_structure import build_turn_expanded_structure, turn_cost


def compile_search_kernels() -> None:
    """探索のJIT（出て戻れるNodeの集まり・来た道を戻らずに行き来できるNode・一対全木・木の繋ぎ目・木の経路どうしの重複率・木を継いだ経路の取り出しと重複率・2点間探索）を、最小の道路網で1回ずつ呼んでコンパイルする。
    探索が読む費用を組み立てるJIT（`domain/leg_costs.py: compile_leg_cost_kernels`）も併せて焼く。

    `@njit(cache=True)`の結果はJITを定義したファイルの隣の`__pycache__`に残り、別のプロセスはそこから読む。
    イメージの組み立て（`backend/Dockerfile`）で呼び、入れ替えたコンテナの最初のルート生成が
    コンパイルを待たないようにする。探索の入口が引数の型を揃える（`domain/search_graph.py: kernel_array`）ため、ここで
    作る入力は形が合えばよい。焼くのはここがPythonから呼ぶJITだけなので、本番の経路がPythonから呼ぶJITも
    ここで呼ぶものに限る（部品は探索の中へ展開し、Pythonからは素の関数を呼ぶ）。

    コンパイルは引数の型だけを見て、値は結果に効かない。イメージの組み立てではDBの較正値を読めないので、宣言の全idに仮の値
    （1）を置いた束を渡す。
    """
    tuning = Tuning(dict.fromkeys(TUNING_PARAMETERS_BY_ID, 1.0))
    lazy_graph = build_lazy_road_graph(np.array([0, 1]), np.array([1, 0]), 2)
    statics = build_search_graph_statics(lazy_graph, np.ones(2))
    largest_strongly_connected_nodes(statics.csr, np.ones(2, dtype=bool))
    nodes_reached_without_retracing(statics.csr, np.ones(2, dtype=bool), np.ones(2, dtype=bool), [0])
    structure = build_turn_expanded_structure(
        statics.csr, lazy_graph, np.zeros(2), np.zeros(2), np.zeros(2, dtype=np.int64), turn_cost(tuning),
        np.zeros(2, dtype=bool), np.zeros(2, dtype=np.int64), np.ones(2, dtype=np.int16), np.ones(2), 1.0,
    )
    cost = np.ones((1, 2))
    origin_states = np.array([0])
    tree = build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, origin_states, lazy_graph.node_count, edge_seconds=cost,
        transition_cost=structure.turn_seconds,
    )
    junction = combine_forward_backward_at_nodes(structure, tree, tree, lazy_graph.node_count, structure.turn_seconds)
    paths = JunctionPaths(junction, tree, tree, lazy_graph.edge_from, lazy_graph.edge_to)
    for node_index in range(lazy_graph.node_count):
        paths.edges(node_index)
    overlap = TreePathOverlap(tree)
    overlap.accept(1)
    overlap.max_ratio(0)
    edge_overlap = EdgeSetOverlap[int](lambda item: np.array([item]), statics.edge_length_m, 1)
    edge_overlap.accept(0)
    edge_overlap.max_ratio(0)
    turn_expanded_shortest_path(structure, cost, np.zeros(2), origin_states, 0, edge_seconds=cost,
                                transition_cost=structure.turn_seconds)
    compile_leg_cost_kernels(tuning)
