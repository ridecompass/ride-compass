"""`app/domain/turn_structure.py`——ターンの遷移と秒・案内する曲がりの組み立て。

ここで見ないもの:
- 較正値そのものの妥当性（左折が何秒か） → `domain/tuning.py`側。較正値をターンの費用へ詰める
  `current_turn_cost`は判断を持たないので単体では見ない（`test_route_generation_behavior.py`が通す）
- 遷移を使った探索 → `test_routing.py`
"""
import dataclasses

import numpy as np
import pytest

from app.domain import traffic, turn_structure
from tests.search_graph_world import (
    ONE_WAY_EDGES,
    ONE_WAY_NODES,
    PLUS_EDGES,
    PLUS_NODES,
    TURN_SPEC,
    build_all,
    lazy_of,
    make_graph,
    state_index,
)


def transitions(lazy, structure):
    """`(遷移元edge_id, 遷移先edge_id) -> (曲がりの種類, ターンの秒数)`。"""
    out = {}
    for source in range(structure.state_count):
        for entry in range(int(structure.indptr[source]), int(structure.indptr[source + 1])):
            target = int(structure.target_state[entry])
            out[(lazy.edge_ids[source], lazy.edge_ids[target])] = (
                turn_structure.TurnKind(int(structure.turn_kind[entry])), float(structure.turn_seconds[entry]))
    return out


def transition_seconds(lazy, structure):
    return {pair: seconds for pair, (_kind, seconds) in transitions(lazy, structure).items()}


def rank_array(lazy, by_edge_id):
    return np.array([by_edge_id[edge_id] for edge_id in lazy.edge_ids], dtype=np.int64)

# --- edge_bearings ---


def test_edge_bearings_prefer_the_stored_value_and_fall_back_to_the_node_pair():
    """折れ線から求めた向きがあればそれを使い、持たない区間だけ両端Nodeから補う。"""
    graph = make_graph(
        {"a": (35.0, 139.0), "b": (35.0, 139.01)},
        {"stored": ("a", "b", 100.0, 123.0), "derived": ("b", "a", 100.0, None)},
    )
    lazy = lazy_of(graph)
    bearings = dict(
        zip(lazy.edge_ids, turn_structure.edge_bearings(lazy.graph, graph.start_bearing_deg, graph.latitude, graph.longitude))
    )
    assert bearings["stored"] == pytest.approx(123.0)
    assert bearings["derived"] == pytest.approx(270.0, abs=1.0)


# --- build_turn_expanded_structure ---


# 十字路の各区間を、Cから離れた側で60度向きを変える折れ線にしたもの。Cのそばの向きは`PLUS_EDGES`と同じ。
CURVED_PLUS_EDGES = {
    edge_id: (tail, head, distance_m, (bearing + 60.0, bearing) if head == "C" else (bearing, bearing - 60.0))
    for edge_id, (tail, head, distance_m, bearing) in PLUS_EDGES.items()
}


@pytest.mark.parametrize("edges", [PLUS_EDGES, CURVED_PLUS_EDGES])
def test_turn_transitions_lead_to_every_outgoing_edge_and_classify_the_turn(edges):
    """状態eの遷移先は「eの終点Nodeから出る全区間」。Uターンも禁止せず遷移として持つ
    （袋小路からの折り返しに要る）。

    方位差の符号で左右を分け、直進とみなす幅の内側は0秒、始点へ戻る遷移はUターン。向きは交差点の
    そばで測るので、区間が交差点から離れた所で曲がっていても分け方は変わらない（区間の端から端の向きで
    測ると、交差点の直進が曲がりに・曲がりが直進に見える）。
    """
    graph = make_graph(PLUS_NODES, edges)
    lazy, _, structure = build_all(graph, spec=TURN_SPEC)
    from_west = {target: turn for (source, target), turn in transitions(lazy, structure).items() if source == "WC"}
    assert from_west == {
        "CE": (turn_structure.TurnKind.STRAIGHT, 0.0),
        "CN": (turn_structure.TurnKind.LEFT, pytest.approx(TURN_SPEC.left.expected_seconds)),
        "CS": (turn_structure.TurnKind.RIGHT, pytest.approx(TURN_SPEC.right.expected_seconds)),
        "CW": (turn_structure.TurnKind.UTURN, pytest.approx(TURN_SPEC.uturn.expected_seconds)),
    }


# 角 A-B-C で B が直角に曲がる（B に分かれ道は無い）。
BEND_NODES = {"A": (35.0, 138.99), "B": (35.0, 139.0), "C": (35.01, 139.0)}
BEND_EDGES = {
    "AB": ("A", "B", 100.0, 90.0),
    "BA": ("B", "A", 100.0, 270.0),
    "BC": ("B", "C", 100.0, 0.0),
    "CB": ("C", "B", 100.0, 180.0),
}


# Y字。南から北向き（方位0）でYへ入り、左の枝と右の枝がどちらも直進とみなす幅の内側で分かれる。
Y_NODES = {"S": (34.99, 139.0), "Y": (35.0, 139.0), "L": (35.01, 138.998), "R": (35.01, 139.002)}


def y_fork_edges(left_deg, right_deg):
    """左の枝を方位`left_deg`、右の枝を方位`right_deg`でYから出すY字の区間。"""
    return {
        "SY": ("S", "Y", 100.0, 0.0),
        "YS": ("Y", "S", 100.0, 180.0),
        "YL": ("Y", "L", 100.0, left_deg),
        "LY": ("L", "Y", 100.0, (left_deg + 180.0) % 360.0),
        "YR": ("Y", "R", 100.0, right_deg),
        "RY": ("R", "Y", 100.0, (right_deg + 180.0) % 360.0),
    }


@pytest.mark.parametrize(
    ("nodes", "edges", "route", "expected"),
    [
        # 十字路の曲がりは案内し、直進は案内しない。曲がりの分け方は遷移の分類のテストが見る。
        (PLUS_NODES, PLUS_EDGES, ["WC", "CN"], [(1, turn_structure.TurnKind.LEFT)]),
        (PLUS_NODES, PLUS_EDGES, ["WC", "CE"], []),
        # 分かれ道の無い角では、道なりに曲がるだけなので案内しない。
        (BEND_NODES, BEND_EDGES, ["AB", "BC"], []),
        # 浅いY字では、よりまっすぐに近い枝が別にある方へ進むときだけ、その向きで案内する。
        (Y_NODES, y_fork_edges(340.0, 10.0), ["SY", "YL"], [(1, turn_structure.TurnKind.LEFT)]),
        (Y_NODES, y_fork_edges(340.0, 10.0), ["SY", "YR"], []),
        (Y_NODES, y_fork_edges(350.0, 20.0), ["SY", "YR"], [(1, turn_structure.TurnKind.RIGHT)]),
    ],
)
def test_turns_along_a_path_are_the_turns_at_a_branch(nodes, edges, route, expected):
    """案内する曲がりは、3本以上の道が集まる点（分かれ道）での、直進でない遷移と、
    よりまっすぐに近い道を外れて進む遷移。分かれ道の無い角で案内すると、道なりに進むだけの所で「曲がる」と
    言ってしまい、浅いY字で道なりでない方へ入る所で案内しないと、道なりの方へ進んでしまう。"""
    graph = make_graph(nodes, edges)
    lazy, _, structure = build_all(graph, spec=TURN_SPEC)
    index = state_index(lazy)

    turns = turn_structure.turns_along(structure, structure.entries_along([index[edge_id] for edge_id in route]))

    assert [(turn.index, turn.kind) for turn in turns] == expected


# 「そもそも待ちの要る階級か」の境目（`domain/traffic.py`が決める）。
MAJOR = traffic.MAJOR_CROSSING_MIN_RANK


def test_a_shallow_fork_guided_off_the_straighter_branch_adds_no_turn_wait():
    """浅いY字で道なりでない方へ入る所は案内するが、待ちは向きの差で決めたまま（直進とみなす幅の内側は0秒）。"""
    graph = make_graph(Y_NODES, y_fork_edges(340.0, 10.0))
    lazy, _, structure = build_all(graph, spec=TURN_SPEC)
    assert transition_seconds(lazy, structure)[("SY", "YL")] == pytest.approx(0.0)


def test_a_bend_without_a_branch_adds_no_wait_even_beside_a_higher_ranked_road():
    """分かれ道の無い点（道のデータの継ぎ目）では道を選ばないので、曲がりの待ちも上位の道の待ちも足さない。
    足すと、同じカーブでも区間の継ぎ目の位置しだいで経路と所要が変わる。来た道へ戻るUターンの待ちは足す。"""
    graph = make_graph(BEND_NODES, BEND_EDGES)
    lazy = lazy_of(graph)
    ranks = rank_array(lazy, {edge_id: (MAJOR if edge_id in {"BC", "CB"} else MAJOR - 1) for edge_id in BEND_EDGES})
    _, _, structure = build_all(graph, spec=TURN_SPEC, edge_rank=ranks)
    from_a = {
        target: seconds for (source, target), seconds in transition_seconds(lazy, structure).items()
        if source == "AB"
    }
    assert from_a == pytest.approx({"BC": 0.0, "BA": TURN_SPEC.uturn.expected_seconds})


# T字路。西から東へ来て、東の道は向こうからCへ入る一方通行なので、進めるのは北への左折だけ。
NO_ENTRY_AHEAD_EDGES = {k: PLUS_EDGES[k] for k in ("WC", "CW", "EC", "CN", "NC")}


def test_a_turn_where_the_road_ahead_is_no_entry_is_still_a_turn_at_a_branch():
    """分かれ道かは、その点に集まる道の本数で決める。進めない道（向こうから来る一方通行）も交差点の道で、
    進める道だけで数えると、交差点の左折が道のデータの継ぎ目に見え、案内も待ちも消える。"""
    graph = make_graph(ONE_WAY_NODES, NO_ENTRY_AHEAD_EDGES)
    lazy, _, structure = build_all(graph, spec=TURN_SPEC)
    index = state_index(lazy)

    turns = turn_structure.turns_along(structure, structure.entries_along([index["WC"], index["CN"]]))

    assert [(turn.index, turn.kind) for turn in turns] == [(1, turn_structure.TurnKind.LEFT)]
    assert transition_seconds(lazy, structure)[("WC", "CN")] == pytest.approx(TURN_SPEC.left.expected_seconds)


def _plus_ranks(lazy, crossing_rank, entering_rank):
    return rank_array(
        lazy,
        {
            edge_id: (crossing_rank if edge_id in {"CN", "NC", "CS", "SC"} else entering_rank)
            for edge_id in PLUS_EDGES
        },
    )


def test_crossing_a_higher_ranked_road_adds_a_wait_split_by_straight_or_turning():
    """信号の無い交差点で上位の道と交わるとき、横断（直進）と右左折で別の秒数を足す。"""
    graph = make_graph(PLUS_NODES, PLUS_EDGES)
    lazy = lazy_of(graph)
    _, _, structure = build_all(
        graph, spec=TURN_SPEC, edge_rank=_plus_ranks(lazy, MAJOR, MAJOR - 1)
    )
    seconds = transition_seconds(lazy, structure)
    assert seconds[("WC", "CE")] == pytest.approx(TURN_SPEC.major_crossing.expected_seconds)
    assert seconds[("WC", "CN")] == pytest.approx(
        TURN_SPEC.left.expected_seconds + TURN_SPEC.major_turn.expected_seconds
    )
    assert seconds[("WC", "CS")] == pytest.approx(
        TURN_SPEC.right.expected_seconds + TURN_SPEC.major_turn.expected_seconds
    )
    assert seconds[("WC", "CW")] == pytest.approx(TURN_SPEC.uturn.expected_seconds)


@pytest.mark.parametrize(
    ("crossing_rank", "entering_rank", "signal", "db_rank", "expected"),
    [
        # 「自分より上位」だけでは足りない——待ちの要る階級に達していなければ足さない。
        (MAJOR - 1, MAJOR - 2, False, 0, 0.0),
        # 信号のある交差点の待ちは停止密度の材料が運ぶ。ここで足すと同じ待ちを二重に数える。
        (MAJOR, MAJOR - 1, True, 0, 0.0),
        # bboxの外へはみ出した上位の道は部分グラフに現れない。DB側の集計値があれば大きい方を採る。
        (MAJOR - 1, MAJOR - 1, False, MAJOR, TURN_SPEC.major_crossing.expected_seconds),
    ],
)
def test_crossing_wait_follows_the_node_rank_and_signal(crossing_rank, entering_rank, signal, db_rank, expected):
    graph = make_graph(PLUS_NODES, PLUS_EDGES)
    lazy = lazy_of(graph)
    center = lazy.node_id_to_index["C"]
    signals = np.zeros(lazy.node_count, dtype=bool)
    signals[center] = signal
    node_db_rank = np.zeros(lazy.node_count, dtype=np.int64)
    node_db_rank[center] = db_rank
    _, _, structure = build_all(
        graph,
        spec=TURN_SPEC,
        edge_rank=_plus_ranks(lazy, crossing_rank, entering_rank),
        node_has_signal=signals,
        node_db_rank=node_db_rank,
    )
    assert transition_seconds(lazy, structure)[("WC", "CE")] == pytest.approx(expected)


def test_node_rank_comes_from_roads_that_leave_the_node_too():
    """Nodeの階級は、そこへ入る道だけでなく出る道からも取る。

    一方通行の幹線が出ていくだけの交差点でも、渡るときの待ちが付く。
    """
    graph = make_graph(ONE_WAY_NODES, ONE_WAY_EDGES)
    lazy = lazy_of(graph)
    ranks = rank_array(
        lazy,
        {
            edge_id: (MAJOR if edge_id == "CN" else MAJOR - 1)
            for edge_id in ONE_WAY_EDGES
        },
    )
    _, _, structure = build_all(graph, spec=TURN_SPEC, edge_rank=ranks)
    assert transition_seconds(lazy, structure)[("WC", "CE")] == pytest.approx(
        TURN_SPEC.major_crossing.expected_seconds
    )


def test_a_turn_onto_a_major_road_waits_for_both_but_kicks_off_once():
    """信号の無い交差点で上位の道へ曲がると、曲がりの待ちと上位の道の待ちを足すが、止まるのは1回なので漕ぎ出しは1回ぶん
    （重なる出来事の大きい方）だけ費用に足す。"""
    graph = make_graph(PLUS_NODES, PLUS_EDGES)
    lazy = lazy_of(graph)
    _, _, structure = build_all(graph, spec=TURN_SPEC, edge_rank=_plus_ranks(lazy, MAJOR, MAJOR - 1), stop_cost_seconds=4.0)
    entry = _entries(lazy, structure)[("WC", "CS")]  # 右折で上位の道へ

    assert float(structure.turn_seconds[entry]) == pytest.approx(
        TURN_SPEC.right.expected_seconds + TURN_SPEC.major_turn.expected_seconds)
    assert float(structure.turn_cost[entry]) == pytest.approx(float(structure.turn_seconds[entry]) + 4.0)


def test_reverse_transitions_flip_direction_and_carry_the_original_wait():
    """後ろ向きの遷移は向きだけを反転し、ターンの時間と費用は元の進行方向の値のまま運ぶ。"""
    graph = make_graph(PLUS_NODES, PLUS_EDGES)
    lazy, _, structure = build_all(graph, spec=TURN_SPEC, stop_cost_seconds=4.0)
    forward = {pair: (float(structure.turn_seconds[entry]), float(structure.turn_cost[entry]))
               for pair, entry in _entries(lazy, structure).items()}
    indptr, source_state, turn_seconds, turn_cost = structure.reverse_transitions()
    backward = {}
    for target in range(structure.state_count):
        for entry in range(int(indptr[target]), int(indptr[target + 1])):
            key = (lazy.edge_ids[int(source_state[entry])], lazy.edge_ids[target])
            backward[key] = (float(turn_seconds[entry]), float(turn_cost[entry]))
    assert backward == forward


def _entries(lazy, structure):
    """`(遷移元edge_id, 遷移先edge_id) -> 遷移の位置`。"""
    return {
        (lazy.edge_ids[source], lazy.edge_ids[int(structure.target_state[entry])]): entry
        for source in range(structure.state_count)
        for entry in range(int(structure.indptr[source]), int(structure.indptr[source + 1]))
    }


def test_a_turn_costs_its_time_and_the_kickoff_of_each_stop_and_only_part_of_it_for_a_slowdown():
    """曲がる所の時間は 割合 × 待ち、費用は時間に「止まる回数の換算 × 1回の漕ぎ出しの代償」を足したもの。右折・Uターンは
    止まる出来事、左折は減速だけの出来事で、巡航速度の半分から戻すので漕ぎ出しは（1 − 0.5²）回ぶん。割合は時間と体力の
    両方に掛かる。"""
    graph = make_graph(PLUS_NODES, PLUS_EDGES)
    spec = dataclasses.replace(TURN_SPEC, right=traffic.StopEvent(share=0.5, wait_seconds=3.0, slows_only=False))
    lazy, _, structure = build_all(graph, spec=spec, stop_cost_seconds=4.0)
    entries = _entries(lazy, structure)

    def seconds_and_cost(pair):
        return float(structure.turn_seconds[entries[pair]]), float(structure.turn_cost[entries[pair]])

    assert seconds_and_cost(("WC", "CN")) == pytest.approx((5.0, 5.0 + 0.75 * 4.0))  # 左折（減速）
    assert seconds_and_cost(("WC", "CS")) == pytest.approx((1.5, 1.5 + 0.5 * 4.0))  # 右折（半分の割合で止まる）
    assert seconds_and_cost(("WC", "CW")) == pytest.approx((20.0, 20.0 + 4.0))  # Uターン
    assert seconds_and_cost(("WC", "CE")) == pytest.approx((0.0, 0.0))  # 直進
