"""`app/domain/routing.py`——計算済みのEdge Costで経路を探す層。

見るもの: 一対全の木と2点間探索の結果（コスト・時刻ビン・経路の復元）、優先度キュー。

ここで見ないもの:
- Edge Costの中身（勾配・路面・風がどう秒へ化けるか） → `test_leg_costs.py`
- 探索用グラフ・ターンの遷移の組み立て → `test_search_graph.py`・`test_turn_structure.py`
- 木から経路を取り出す・測る・繋ぐ → `test_tree_paths.py`
- 置いた点を寄せてよいノード → `test_connectivity.py`
- 探索のJITの焼き付け → `test_search_kernels.py`
- 候補ルートの並べ方・返し方 → `route_generator`側
"""
import math

import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain import routing, tree_paths
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
        edge_seconds=np.ones(structure.state_count), transition_cost=structure.turn_seconds
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
            edge_seconds=np.ones((2, states)), bin_seconds=30.0, **kwargs, transition_cost=structure.turn_seconds
        )

    full = tree()
    bound = routing.tree_cost_bound(structure, cost, edge_length_m, length_m, transition_cost=structure.turn_seconds)
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
    bound = routing.tree_cost_bound(structure, cost, statics.edge_length_m, 400.0, transition_cost=structure.turn_seconds)
    tree = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, out_states(lazy, "a"), lazy.node_count,
        cost_limit=bound, edge_seconds=np.ones((2, structure.state_count)), bin_seconds=1.5, transition_cost=structure.turn_seconds
    )
    assert tree.state_cost[last] == pytest.approx(10.0 * 3 + 100.0 + 2 * TURN_SPEC.left.expected_seconds + TURN_SPEC.right.expected_seconds)


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
        edge_seconds=np.ones(structure.state_count), transition_cost=structure.turn_seconds
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
        edge_seconds=np.ones(structure.state_count), transition_cost=structure.turn_seconds
    )
    isolated = lazy.node_id_to_index["Z"]
    assert tree.node_cost[isolated] == math.inf
    assert np.isnan(tree.node_length_m[isolated])
    assert tree_paths.turn_expanded_path_edge_indices(tree, isolated) is None


def test_tree_adds_the_transition_cost_to_the_cost_and_the_turn_time_to_the_seconds():
    """ターンは、木のコストには呼び手が渡す遷移の費用、所要時間には構造のターンの時間で入る。所要時間は遷移の費用
    （利用者ごとに変わる）で変わらない。"""
    graph = make_graph(PLUS_NODES, PLUS_EDGES)
    lazy, statics, structure = build_all(graph, spec=TURN_SPEC)
    states = state_index(lazy)
    cost = np.ones(structure.state_count)
    seconds = np.full(structure.state_count, 10.0)
    tree = routing.build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, np.array([states["WC"]], dtype=np.int64),
        lazy.node_count, edge_seconds=seconds, bin_seconds=1000.0, transition_cost=structure.turn_seconds + 4.0,
    )
    assert tree.state_cost[states["CN"]] == pytest.approx(1.0 + TURN_SPEC.left.expected_seconds + 4.0 + 1.0)
    assert tree.state_seconds[states["CN"]] == pytest.approx(10.0 + TURN_SPEC.left.expected_seconds + 10.0)


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
        lazy.node_count, edge_seconds=seconds, bin_seconds=bin_seconds, transition_cost=structure.turn_seconds
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
        edge_seconds=np.ones(structure.state_count), transition_cost=structure.turn_seconds
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
            lazy.node_count, reverse=True, edge_seconds=seconds, bin_seconds=5.0, transition_cost=structure.turn_seconds
        )


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


@pytest.mark.parametrize(
    ("cost_shape", "seconds_shape", "bin_seconds"),
    [
        # 黙って(1, n)へ潰すと、ビン数の食い違いの検査もすり抜けてJITが範囲外を読む
        ((2, 3, 4), (2, 3, 4), 60.0),
        # 幅が無いと全区間が先頭のビンへ落ち、例外もNaNも出ないまま結果だけが変わる
        ((2, 3), (2, 3), 0.0),
        ((2, 3), (2, 3), math.inf),
        # JITした探索は境界を検査しない。ビン数が食い違えば範囲外の読み出しになる
        ((2, 3), (2, 4), 60.0),
    ],
)
def test_time_bins_the_search_would_misread_are_refused(cost_shape, seconds_shape, bin_seconds):
    with pytest.raises(ValueError):
        routing.time_bin_arrays("caller", np.ones(cost_shape), np.ones(seconds_shape), bin_seconds)


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
        edge_seconds=np.ones(structure.state_count), transition_cost=structure.turn_seconds
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
        edge_seconds=np.ones(structure.state_count), transition_cost=structure.turn_seconds
    )
    assert path == [states["CE"]]


def test_shortest_path_is_none_when_the_goal_cannot_be_reached():
    graph = make_graph(LINE_NODES, LINE_EDGES)
    lazy, _, structure = build_all(graph)
    states = state_index(lazy)
    path = routing.turn_expanded_shortest_path(
        structure, np.ones(structure.state_count), np.zeros(lazy.node_count),
        np.array([states["AB"]], dtype=np.int64), lazy.node_id_to_index["Z"],
        edge_seconds=np.ones(structure.state_count), transition_cost=structure.turn_seconds
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
        edge_seconds=np.ones(structure.state_count), transition_cost=structure.turn_seconds
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
        lazy.node_id_to_index["C"], edge_seconds=seconds, bin_seconds=bin_seconds, transition_cost=structure.turn_seconds
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
        edge_seconds=np.ones(structure.state_count), transition_cost=structure.turn_seconds
    )
    assert path == [states["OH"], states["HL0"], states["L0G"]]
