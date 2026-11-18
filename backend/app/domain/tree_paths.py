"""一対全最短経路木（`domain/routing.py: TurnExpandedTree`）から経路を取り出す・測る・繋ぐ。

前向き木の経路の復元、同じ木の経路どうしの重複率、前向き木と後ろ向き木をNodeで繋ぐ繋ぎ目と、そこで継いだ経路の
取り出しを持つ。木そのものの探索は`domain/routing.py`が持つ。
"""
from dataclasses import dataclass

import numpy as np
from numba import njit
from app.domain.routing import TurnExpandedTree, walk_from_source, walk_predecessors
from app.domain.search_graph import EDGE_VALUE_DTYPE, SEARCH_INDEX_DTYPE, kernel_array
from app.domain.turn_structure import TurnExpandedStructure

def turn_expanded_path_from_state(tree: TurnExpandedTree, state_index: int) -> list[int]:
    """前向き木で、始点→`state_index`の経路をEdge index列（進行順）で返す。"""
    return walk_from_source(tree.predecessor, state_index)


def turn_expanded_path_edge_indices(tree: TurnExpandedTree, target_node_index: int) -> list[int] | None:
    """木上の始点→`target_node_index`の経路をEdge index列で返す。到達不能ならNone。"""
    state = int(tree.node_best_state[target_node_index])
    if state < 0:
        return None
    return turn_expanded_path_from_state(tree, state)


class TreePathOverlap:
    """前向き木の始点からNodeまでの経路どうしの重複率（`domain/route_diversity.py: OverlapMeasure`）。
    itemはNode index で、経路は`turn_expanded_path_edge_indices`が返すもの。

    同じ木の経路どうしが共有する区間は、分かれる点までの頭の部分だけ（木ではどの状態への経路も1本に決まる）。
    候補から親を辿って最初に当たる採用済みの経路の状態は、どの採用済みと分かれる点よりも深い（そこまでは
    採用済みのどれかと共有し、その先はどれとも共有しない）ので、最大の重複率はその状態と候補の木の積算の
    実距離の比になる。候補の経路を取り出さず、採用済みの経路の状態に印を付けるだけで測れる。
    """

    def __init__(self, tree: TurnExpandedTree):
        self._tree = tree
        self._accepted = np.zeros(len(tree.predecessor), dtype=np.bool_)
        self._accepted_any = False

    def max_ratio(self, node_index: int) -> float | None:
        state = int(self._tree.node_best_state[node_index])
        if state < 0:
            return None
        if not self._accepted_any:
            return 0.0
        return _tree_shared_ratio(self._tree.predecessor, self._tree.state_length_m, self._accepted, state)

    def accept(self, node_index: int) -> None:
        self._accepted[turn_expanded_path_edge_indices(self._tree, node_index)] = True
        self._accepted_any = True


@njit(cache=True, nogil=True)
def _tree_shared_ratio(
    predecessor: np.ndarray, state_length_m: np.ndarray, accepted: np.ndarray, state: int,
) -> float:
    """`state`までの経路のうち、印の付いた最初の祖先（自身を含む）までの実距離の割合。印が無ければ0。"""
    total = state_length_m[state]
    current = state
    while current >= 0 and not accepted[current]:
        current = predecessor[current]
    if current < 0 or not total > 0.0:
        return 0.0
    return state_length_m[current] / total


@dataclass
class NodeJunction:
    """前向き木と後ろ向き木を各Nodeで繋いだ結果。配列はNode index順。"""

    # 繋いだ合計コスト（前向き＋そのNodeでのターン＋後ろ向き）。繋げないNodeはinf。
    cost: np.ndarray
    # 同じ経路の実距離（m）。繋げないNodeはNaN。
    length_m: np.ndarray
    # 繋いだときの前向き側・後ろ向き側の状態（Edge index）。繋げないNodeは-1。
    forward_state: np.ndarray
    backward_state: np.ndarray


def add_terminal_candidate(
    junction: NodeJunction, forward: TurnExpandedTree, destination_index: int
) -> None:
    """目的地そのものを経由Nodeとする候補（＝どこも経由せず目的地で終わる経路）を足す。

    `combine_forward_backward_at_nodes`は「入る区間×出る区間」の対でNodeを繋ぐため、
    そこで終わる経路は現れない。後ろ向きの区間が無いことは`backward_state=-1`で表す。

    **`NodeJunction`の全フィールドを揃えて書く**——1つでも繋ぎ目側の値が残ると、コストと
    実距離が別々の経路のものになり、1kmあたりの費用が別の経路のものになる。
    """
    state = int(forward.node_best_state[destination_index])
    if state < 0:
        return
    junction.cost[destination_index] = forward.node_cost[destination_index]
    junction.length_m[destination_index] = forward.node_length_m[destination_index]
    junction.forward_state[destination_index] = state
    junction.backward_state[destination_index] = -1


def combine_forward_backward_at_nodes(
    structure: TurnExpandedStructure,
    forward: TurnExpandedTree,
    backward: TurnExpandedTree,
    node_count: int,
    transition_cost: np.ndarray,
) -> NodeJunction:
    """前向き木と後ろ向き木を、Nodeごとに「そこでのターンの費用を含めて」繋ぐ。

    Nodeで単に`forward.node_cost + backward.node_cost`を足すと、そのNodeを通り抜けるときの
    ターンの費用が抜ける（入る方向と出る方向の組み合わせで決まるため）。遷移（入る区間×出る
    区間の対）ごとに合計を求め、Nodeごとの最小を採る。
    """
    cost, forward_state, transition = _junction_best_transitions(
        kernel_array(structure.indptr, SEARCH_INDEX_DTYPE), kernel_array(structure.target_state, SEARCH_INDEX_DTYPE),
        kernel_array(structure.edge_to, np.int64), kernel_array(transition_cost, EDGE_VALUE_DTYPE),
        forward.state_cost, backward.state_cost, int(node_count),
    )
    backward_state = np.full(node_count, -1, dtype=np.int64)
    length_m = np.full(node_count, np.nan)
    joined = np.flatnonzero(transition >= 0)
    source, picked = forward_state[joined], transition[joined]
    target = structure.target_state[picked]
    backward_state[joined] = target
    length_m[joined] = forward.state_length_m[source] + backward.state_length_m[target]
    return NodeJunction(
        cost=cost, length_m=length_m,
        forward_state=forward_state, backward_state=backward_state,
    )


@njit(cache=True, nogil=True)
def _junction_best_transitions(
    indptr: np.ndarray, target_state: np.ndarray, edge_to: np.ndarray, transition_cost: np.ndarray,
    forward_cost: np.ndarray, backward_cost: np.ndarray, node_count: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Nodeごとに、合計の費用が有限で最小の遷移（合計・前向きの状態・遷移の番号。無ければinf・-1・-1）。

    遷移を番号の順に1回だけ見て、厳密な`<`で先に見たものを残す（同じ合計なら番号の小さい遷移が残る）。
    """
    best_cost = np.full(node_count, np.inf)
    best_source = np.full(node_count, -1, dtype=np.int64)
    best_transition = np.full(node_count, -1, dtype=np.int64)
    for source in range(len(indptr) - 1):
        forward = forward_cost[source]
        if not forward < np.inf:
            continue
        node = edge_to[source]
        for transition in range(indptr[source], indptr[source + 1]):
            total = forward + transition_cost[transition] + backward_cost[target_state[transition]]
            if total < best_cost[node]:
                best_cost[node] = total
                best_source[node] = source
                best_transition[node] = transition
    return best_cost, best_source, best_transition


class JunctionPaths:
    """`NodeJunction`が各Nodeで継いだ経路（前向き木の始点→Node→後ろ向き木の始点）を取り出す。

    経路は前向き・後ろ向きの区間の番号列を継いだもので、両側が同じ物理区間（進行方向を無視した両端のNodeの組）を
    通るNodeは、行って戻る形で経路にならない——同じ道を逆向きの区間で戻る形は、区間の番号の比較では見つからない。
    """

    def __init__(
        self, junction: NodeJunction, forward: TurnExpandedTree, backward: TurnExpandedTree,
        edge_from: np.ndarray, edge_to: np.ndarray,
    ):
        self._junction = junction
        self._forward_predecessor = forward.predecessor
        self._backward_predecessor = backward.predecessor
        self._edge_from = kernel_array(edge_from, np.int64)
        self._edge_to = kernel_array(edge_to, np.int64)

    def edges(self, node_index: int) -> np.ndarray | None:
        """`node_index`を経由する経路の区間の番号列（進行順）。経路にならなければNone。"""
        found = self._path(node_index)
        return None if found is None else found[0]

    def halves(self, node_index: int) -> tuple[list[int], list[int]] | None:
        """`node_index`を経由する経路の（前向き, 後ろ向き）の区間の番号列。経路にならなければNone。"""
        found = self._path(node_index)
        if found is None:
            return None
        edges, forward_count = found
        return edges[:forward_count].tolist(), edges[forward_count:].tolist()

    def _path(self, node_index: int) -> tuple[np.ndarray, int] | None:
        forward_state = int(self._junction.forward_state[node_index])
        if forward_state < 0:
            return None
        forward = walk_predecessors(self._forward_predecessor, forward_state)[::-1]
        # backward_stateが-1なのは終点そのものを指す場合で、後ろ向きの区間は無い。
        backward_state = int(self._junction.backward_state[node_index])
        backward = (
            walk_predecessors(self._backward_predecessor, backward_state) if backward_state >= 0
            else np.empty(0, dtype=np.int64)
        )
        if _shares_physical_edge(forward, backward, self._edge_from, self._edge_to, len(self._junction.cost)):
            return None
        return np.concatenate((forward, backward)), len(forward)


@njit(cache=True, nogil=True)
def _shares_physical_edge(
    forward: np.ndarray, backward: np.ndarray, edge_from: np.ndarray, edge_to: np.ndarray, node_count: int,
) -> bool:
    """2つの区間の番号列が、同じ物理区間（進行方向を無視した両端のNodeの組）を通るか。"""
    forward_keys = np.empty(len(forward), dtype=np.int64)
    for position in range(len(forward)):
        tail, head = edge_from[forward[position]], edge_to[forward[position]]
        forward_keys[position] = min(tail, head) * node_count + max(tail, head)
    forward_keys.sort()
    for position in range(len(backward)):
        tail, head = edge_from[backward[position]], edge_to[backward[position]]
        key = min(tail, head) * node_count + max(tail, head)
        found = np.searchsorted(forward_keys, key)
        if found < len(forward_keys) and forward_keys[found] == key:
            return True
    return False
