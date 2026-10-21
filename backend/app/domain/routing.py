"""Route Engine。

Road Graph（domain/graph.py）とEdge Cost（domain/evaluation.py）を使って、2点間の
最小コスト経路を探索する。アルゴリズムは教科書どおりのDijkstra/A*で、独自のものは作らない。

探索の状態は**Nodeではなく有向Edge**で、遷移は`domain/turn_structure.py: TurnExpandedStructure`が持つ。

2点間探索も一対全の最短経路木も、numbaでJITした探索で求める（優先度キューはnumpy配列の
バイナリヒープ）。ライブラリ（scipy等）へ委ねられないのは**到達時刻をラベルとして
持ち回る**ためで、コストが辺の静的な属性である前提のライブラリでは時刻で変わるコストを
表せない。

Pythonから呼ぶ探索のJITはGILを放してコンパイルする（`nogil=True`）。`asyncio.to_thread`で流す間も
イベントループとほかの生成の探索が動くので、探索は渡された配列を読むだけにし、書く配列は関数の中で作る。

Route Engineは、Costの中身（勾配がきつい、路面が悪い等）を一切知らない。ここで扱うのは
Road Graphのトポロジーと、既に計算済みのEdge Costのみ。
"""
import logging
import math
from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np
from numba import njit
from app.domain.stopwatch import elapsed_ms, start_timer
from app.domain.search_graph import (
    EDGE_VALUE_DTYPE,
    SEARCH_INDEX_DTYPE,
    CsrGraphStructure,
    build_lazy_road_graph,
    build_search_graph_statics,
    run_starts,
)
from app.domain.turn_structure import TurnExpandedStructure, build_turn_expanded_structure, current_turn_cost

logger = logging.getLogger("ridecompass.graph")


# --- 一対全最短経路木（フロンティア方式の周回生成の共通基盤） ---


# 優先度キューの初期容量（種の数＋この余裕）。満杯になれば倍へ伸びるため上限を当てる必要は
# 無く、**当ててはいけない**——コストが時刻で変わると押し込み回数が遷移数で頭打ちにならない。
# 小さく始めることで、伸長の経路が普通の探索で毎回通る（使われない分岐にしない）。
HEAP_INITIAL_SLACK = 64

# `tree_cost_bound`が最初に並べる区間の数。帯の上限の距離は、たいていこの数の区間で埋まる
# （全区間を並べ替えるより部分の選び出しのほうが速い）。足りなければ4倍ずつ広げる。
_TREE_BOUND_FIRST_K = 4096
# `tree_cost_bound`の和と探索の和は足す順が違い、浮動小数の丸めの分だけずれうる。そのずれを覆う相対の余裕。
_TREE_BOUND_ROUNDING = 1e-9


def largest_strongly_connected_nodes(csr: CsrGraphStructure, passable: np.ndarray) -> np.ndarray:
    """通れる区間（`passable`、区間の番号順の真偽）だけでたどったとき、互いに行き来できるNodeの一番大きな集まり
    （最大の強連結成分。ノード番号順の真偽）。

    探索の遷移はどの区間からも同じNodeを出るどの区間へも移れる（Uターンも費用で抑えるだけで禁じない）ので、
    Nodeどうしの行き来はターンを展開しても変わらない。この集まりの中のNodeからは、集まりの中のどのNodeへも
    経路があり、集まりの外のNodeへ寄せた点は、出られないか戻れない。
    """
    passable_entries = np.asarray(passable, dtype=np.bool_)[csr.entry_edge_index]
    component = _strong_components(
        csr.indptr.astype(np.int64), csr.indices.astype(np.int64), passable_entries,
    )
    if len(component) == 0:
        return np.zeros(0, dtype=bool)
    return component == int(np.argmax(np.bincount(component)))


@njit(cache=True, nogil=True)
def _strong_components(indptr: np.ndarray, indices: np.ndarray, passable: np.ndarray) -> np.ndarray:
    """Tarjanの強連結成分分解（再帰を明示のスタックへ直したもの）。戻り値はノード番号順の成分の番号。"""
    node_count = len(indptr) - 1
    order = np.full(node_count, -1, dtype=np.int64)
    low = np.zeros(node_count, dtype=np.int64)
    on_stack = np.zeros(node_count, dtype=np.bool_)
    component = np.full(node_count, -1, dtype=np.int64)
    stack = np.empty(node_count, dtype=np.int64)
    call_node = np.empty(node_count, dtype=np.int64)
    call_entry = np.empty(node_count, dtype=np.int64)
    stack_size = 0
    visited = 0
    components = 0
    for root in range(node_count):
        if order[root] != -1:
            continue
        order[root] = visited
        low[root] = visited
        visited += 1
        stack[stack_size] = root
        stack_size += 1
        on_stack[root] = True
        call_node[0] = root
        call_entry[0] = indptr[root]
        depth = 1
        while depth > 0:
            node = call_node[depth - 1]
            entry = call_entry[depth - 1]
            if entry < indptr[node + 1]:
                call_entry[depth - 1] = entry + 1
                if not passable[entry]:
                    continue
                head = indices[entry]
                if order[head] == -1:
                    order[head] = visited
                    low[head] = visited
                    visited += 1
                    stack[stack_size] = head
                    stack_size += 1
                    on_stack[head] = True
                    call_node[depth] = head
                    call_entry[depth] = indptr[head]
                    depth += 1
                elif on_stack[head]:
                    low[node] = min(low[node], order[head])
                continue
            depth -= 1
            if low[node] == order[node]:
                while True:
                    stack_size -= 1
                    member = stack[stack_size]
                    on_stack[member] = False
                    component[member] = components
                    if member == node:
                        break
                components += 1
            if depth > 0:
                parent = call_node[depth - 1]
                low[parent] = min(low[parent], low[node])
    return component


# 探索の優先度キュー（numpy配列のバイナリヒープ）。順位のキー・状態・積んだ時点のコスト`g`の列と、
# `g`の列を使うか。`g`の列を使わないヒープはキーそのものを`g`として扱う。
Heap = tuple[np.ndarray, np.ndarray, np.ndarray, bool]


def _kernel_array(values: np.ndarray, dtype: type) -> np.ndarray:
    """JITした探索へ渡す配列を、1つの型（dtype・C順・書き込み可）へ揃える。揃っている配列は写さない。

    numbaは引数の型（dtype・並び・読み取り専用か）ごとに別々にコンパイルする。揃えずに渡すと、
    イメージの組み立てで焼いたコンパイル結果（`compile_search_kernels`）と型の違う呼び出しが、
    本番の最初のルート生成でコンパイルを払う。
    """
    array: np.ndarray = np.ascontiguousarray(values, dtype=dtype)
    return array if array.flags.writeable else array.copy()


@njit(cache=True, inline="always")
def empty_heap(capacity: int, carries_g: bool) -> Heap:
    """空のヒープを作る。`carries_g`はキーが`g`と別の値になる探索（A*のキーは`g`＋下界）だけが立てる。

    容量は最低1にする——伸長は要素数を倍にするため、容量0からは伸びない。
    """
    capacity = max(capacity, 1)
    return (
        np.empty(capacity),
        np.empty(capacity, dtype=np.int64),
        np.empty(capacity if carries_g else 0),
        carries_g,
    )


@njit(cache=True, inline="always")
def _grown(values: np.ndarray, size: int) -> np.ndarray:
    grown = np.empty(size * 2, dtype=values.dtype)
    grown[:size] = values
    return grown


@njit(cache=True, inline="always")
def heap_push(heap: Heap, size: int, key: float, state: int, g: float = math.nan) -> tuple[Heap, int]:
    """エントリを1つ積み、（伸ばしたかもしれない）ヒープと新しい要素数を返す。`g`は`g`の列を
    使うヒープにだけ渡す（使わないヒープでは取り出しがキーを`g`として返す）。

    **満杯なら倍へ伸ばす**。コストが時刻で変わると「各状態は一度だけ確定する」が成り立たず
    （確定済みの状態が、後から別の時刻ビンを通る安い経路で更新されうる）、押し込み回数が
    遷移数で頭打ちにならない。JITは配列の境界を検査しないため、上限を決め打つと超えた瞬間に
    例外ではなく範囲外書き込みになる。
    """
    heap_key, heap_state, heap_g, carries_g = heap
    if size == heap_key.shape[0]:
        heap_key = _grown(heap_key, size)
        heap_state = _grown(heap_state, size)
        if carries_g:
            heap_g = _grown(heap_g, size)
    j = size
    while j > 0:
        parent = (j - 1) // 2
        if heap_key[parent] <= key:
            break
        heap_key[j] = heap_key[parent]
        heap_state[j] = heap_state[parent]
        if carries_g:
            heap_g[j] = heap_g[parent]
        j = parent
    heap_key[j] = key
    heap_state[j] = state
    if carries_g:
        heap_g[j] = g
    return (heap_key, heap_state, heap_g, carries_g), size + 1


@njit(cache=True, inline="always")
def heap_pop(heap: Heap, size: int) -> tuple[float, int, int]:
    """キー最小のエントリを取り出し、その`g`・状態と新しい要素数を返す。空で呼ばない。"""
    heap_key, heap_state, heap_g, carries_g = heap
    g = heap_g[0] if carries_g else heap_key[0]
    state = heap_state[0]
    size -= 1
    key = heap_key[size]
    last_state = heap_state[size]
    last_g = heap_g[size] if carries_g else key
    j = 0
    while True:
        child = 2 * j + 1
        if child >= size:
            break
        right = child + 1
        if right < size and heap_key[right] < heap_key[child]:
            child = right
        if not heap_key[child] < key:
            break
        heap_key[j] = heap_key[child]
        heap_state[j] = heap_state[child]
        if carries_g:
            heap_g[j] = heap_g[child]
        j = child
    heap_key[j] = key
    heap_state[j] = last_state
    if carries_g:
        heap_g[j] = last_g
    return g, state, size


def time_bin_of(travelled: float, bin_seconds: float, bin_count: int) -> int:
    """出発からの経過時間`travelled`（秒）が落ちる時刻ビン。範囲外は端のビンへ寄せる。区間の表示も経路を
    たどってこれで同じビンを選ぶ（探索と表示が別のビンを読むと、同じ区間の風が食い違う）。

    探索の中では同じ本体をJITした`_time_bin_of_kernel`を展開する。Pythonから呼ぶ側がJITの版を呼ぶと、
    プロセスで最初の呼び出しがイメージに焼いていないコンパイルを払う。
    """
    time_bin = int(travelled / bin_seconds)
    if time_bin >= bin_count:
        return bin_count - 1
    if time_bin < 0:
        return 0
    return time_bin


_time_bin_of_kernel = njit(cache=True, inline="always")(time_bin_of)


@njit(cache=True, nogil=True)
def _turn_expanded_dijkstra(
    indptr: np.ndarray,
    target_state: np.ndarray,
    turn_seconds: np.ndarray,
    edge_cost: np.ndarray,
    edge_seconds: np.ndarray,
    edge_length_m: np.ndarray,
    bin_seconds: float,
    entry_states: np.ndarray,
    cost_limit: float,
    capacity: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """状態＝有向区間・辺＝ターンの一対全Dijkstra（JITコンパイル）。

    `entry_states`（始点から出る区間、または目的地へ入る区間）をその区間自身のコストで
    種にし、コスト`cost_limit`を超えた時点で打ち切る。実距離と素の所要時間は緩和のたびに
    そのまま積むため、前任者を遡り直す積算が要らない。

    `edge_cost`・`edge_seconds`は`(時刻ビン, 状態)`。`_turn_expanded_astar`と同じ1ラベル法で、
    状態ごとにコスト最小の1本だけを保つ。
    """
    state_count = edge_length_m.shape[0]
    bin_count = edge_cost.shape[0]
    best = np.full(state_count, np.inf)
    arrival = np.full(state_count, np.inf)
    length = np.full(state_count, np.nan)
    predecessor = np.full(state_count, -1, dtype=np.int64)
    heap = empty_heap(capacity, False)
    size = 0

    for i in range(entry_states.shape[0]):
        state = entry_states[i]
        g = edge_cost[0, state]
        if not np.isfinite(g) or g > cost_limit or g >= best[state]:
            continue
        best[state] = g
        arrival[state] = edge_seconds[0, state]
        length[state] = edge_length_m[state]
        heap, size = heap_push(heap, size, g, state)

    while size > 0:
        g, state, size = heap_pop(heap, size)
        if g > best[state]:
            continue
        travelled = arrival[state]
        time_bin = _time_bin_of_kernel(travelled, bin_seconds, bin_count)
        for entry in range(indptr[state], indptr[state + 1]):
            nxt = target_state[entry]
            cost = edge_cost[time_bin, nxt]
            if not np.isfinite(cost):
                continue
            wait = turn_seconds[entry]
            next_g = g + cost + wait
            if next_g > cost_limit or next_g >= best[nxt]:
                continue
            best[nxt] = next_g
            arrival[nxt] = travelled + edge_seconds[time_bin, nxt] + wait
            length[nxt] = length[state] + edge_length_m[nxt]
            predecessor[nxt] = state
            heap, size = heap_push(heap, size, next_g, nxt)
    return best, predecessor, length, arrival


@dataclass
class TurnExpandedTree:
    """状態＝有向Edgeの一対全最短経路木。`state_*`は区間の番号順、
    `node_*`はNode index順。

    「起点Nodeのコスト0」という状態を持たない——状態の空間に
    「まだ走っていない」が無いため、起点Nodeの`node_cost`は「起点へ戻ってくるコスト」に
    なる。起点を0として扱いたい呼び出し元は自分で上書きする。
    """

    # 仮想始点から各状態への最小コスト。到達不能はinf。
    state_cost: np.ndarray
    # 木に沿った実距離（m）の積算。到達不能はNaN。
    state_length_m: np.ndarray
    # 木に沿った所要時間（秒）の積算。到達不能はinf。
    state_seconds: np.ndarray
    # Nodeごとの最小コストと、そのコストでNodeへ入る状態（到達不能は-1）。
    node_cost: np.ndarray
    node_best_state: np.ndarray
    # `node_best_state`に対応する実距離（m）・所要時間（秒）。到達不能はNaN。
    node_length_m: np.ndarray
    node_seconds: np.ndarray
    # 木の親となる状態。始点の区間・到達不能は-1。Pythonのlistで持つ（numpy配列への添字アクセスより、
    # 経路復元のループが速い）。既定値を持たせない——省略できると、渡し忘れた木が黙って
    # 「どの状態からも経路が1本も辿れない」ふるまいになる。
    predecessor_list: list[int] = field(repr=False, compare=False)


def build_turn_expanded_tree(
    structure: TurnExpandedStructure,
    edge_cost: np.ndarray,
    edge_length_m: np.ndarray,
    entry_state_indices: np.ndarray,
    node_count: int,
    *,
    reverse: bool = False,
    cost_limit: float = np.inf,
    edge_seconds: np.ndarray,
    bin_seconds: float = np.inf,
) -> TurnExpandedTree:
    """状態＝有向Edgeの一対全Dijkstra（numba、前任者付き）。

    `reverse=True`は遷移の向きだけを反転する（ターンの待ちは元の進行方向のまま）。
    「その区間から目的地まで」のコストが求まる。

    `edge_cost`は1次元（時刻に依存しない）か`(時刻ビン, 状態)`の2次元で、素の所要時間
    `edge_seconds`を同じ形で渡す。ビンが2本以上なら`bin_seconds`も渡す（`turn_expanded_shortest_path`と
    同じ契約）。**逆向きの木は時刻ビンを使えない**——目的地から遡るため各状態の到達時刻が決まらない。
    呼び出し元は1本のビンで呼ぶこと（`reverse=True`へ複数ビンを渡すと`ValueError`）。
    """
    state_count = structure.state_count
    cost_bins, seconds_bins = time_bin_arrays(
        "build_turn_expanded_tree", edge_cost, edge_seconds, bin_seconds
    )
    if reverse and cost_bins.shape[0] > 1:
        # 逆向きの木の`arrival`は「そこから目的地までの残り時間」で、出発からの経過時間では
        # ない。ビンを引くとその残り時間で引かれ、例外もNaNも出ないまま時刻が反転した条件で
        # 評価した経路が返る。
        raise ValueError(
            "build_turn_expanded_tree(reverse=True) cannot use time bins: "
            f"got {cost_bins.shape[0]} bins (pass a single bin; the reverse tree has no arrival clock)"
        )
    if reverse:
        indptr, target_state, transition_seconds = structure.reverse_transitions()
    else:
        indptr, target_state, transition_seconds = (
            structure.indptr, structure.target_state, structure.turn_seconds
        )
    started = start_timer()
    state_cost, predecessor, state_length_m, state_seconds = _turn_expanded_dijkstra(
        _kernel_array(indptr, SEARCH_INDEX_DTYPE), _kernel_array(target_state, SEARCH_INDEX_DTYPE),
        _kernel_array(transition_seconds, EDGE_VALUE_DTYPE),
        _kernel_array(cost_bins, EDGE_VALUE_DTYPE), _kernel_array(seconds_bins, EDGE_VALUE_DTYPE),
        _kernel_array(edge_length_m, np.float64), float(bin_seconds),
        _kernel_array(entry_state_indices, np.int64), float(cost_limit),
        len(entry_state_indices) + HEAP_INITIAL_SLACK,
    )
    dijkstra_ms = elapsed_ms(started)

    fold_started = start_timer()
    # Nodeごとに最小コストの状態を1つ選ぶ（正方向はNodeへ入る状態、逆方向は出る状態）。
    incoming = structure.edge_from if reverse else structure.edge_to
    order = np.lexsort((state_cost, incoming))
    best_states = order[run_starts(incoming[order])]
    node_best_state = np.full(node_count, -1, dtype=np.int64)
    node_cost = np.full(node_count, np.inf)
    node_length_m = np.full(node_count, np.nan)
    node_seconds = np.full(node_count, np.nan)
    finite_best = best_states[np.isfinite(state_cost[best_states])]
    node_best_state[incoming[finite_best]] = finite_best
    node_cost[incoming[finite_best]] = state_cost[finite_best]
    node_length_m[incoming[finite_best]] = state_length_m[finite_best]
    node_seconds[incoming[finite_best]] = state_seconds[finite_best]

    logger.info(
        "turn_expanded_tree reverse=%s states=%d bins=%d dijkstra_ms=%d fold_ms=%d",
        reverse, state_count, cost_bins.shape[0], dijkstra_ms,
        elapsed_ms(fold_started),
    )
    return TurnExpandedTree(
        state_cost=state_cost, state_length_m=state_length_m,
        state_seconds=state_seconds, node_cost=node_cost, node_best_state=node_best_state,
        node_length_m=node_length_m, node_seconds=node_seconds,
        predecessor_list=predecessor.tolist(),
    )


def tree_cost_bound(
    structure: TurnExpandedStructure, edge_cost: np.ndarray, edge_length_m: np.ndarray, length_m: float,
) -> float:
    """前向きの`build_turn_expanded_tree`へ同じ`edge_cost`を渡したとき、実距離`length_m`以内で届く状態の
    木の費用を下回らない値（`cost_limit`に渡すと、その状態を1つも打ち切らない上界）。

    木の費用は、経路の区間ごとの費用（どの時刻ビンかは到達時刻で決まる）と、区間へ入る遷移の待ちの和で、
    経路は同じ区間を2度通らない。区間ごとに「どのビンの費用の最大＋入る遷移の待ちの最大」を重さ、実距離を
    大きさとした分数ナップサックの貪欲で、重さ/大きさの大きい区間から実距離の合計が`length_m`に届くまで足す。
    費用の合成（割り増し・密度・罰）・待ち・走行モデルの形に依らず成り立つ。
    """
    cost_bins = _as_time_bins("tree_cost_bound", edge_cost)
    finite = np.isfinite(cost_bins)
    reachable = finite.any(axis=0)
    entry_wait = np.zeros(structure.state_count)
    np.maximum.at(entry_wait, structure.target_state, structure.turn_seconds)
    weight = (np.max(cost_bins, axis=0, initial=0.0, where=finite) + entry_wait)[reachable]
    size = np.asarray(edge_length_m, dtype=np.float64)[reachable]
    ratio = np.divide(weight, size, out=np.full(weight.shape, np.inf), where=size > 0)
    k = _TREE_BOUND_FIRST_K
    while True:
        top = np.argpartition(-ratio, k - 1)[:k] if k < len(ratio) else np.arange(len(ratio))
        top = top[np.argsort(-ratio[top], kind="stable")]
        filled = np.cumsum(size[top]) >= length_m
        if filled.any() or len(top) == len(ratio):
            picked = top[: int(np.argmax(filled)) + 1] if filled.any() else top
            return float(weight[picked].sum()) * (1.0 + _TREE_BOUND_ROUNDING)
        k *= 4


def _walk_predecessors(predecessors: Sequence[int] | np.ndarray, state_index: int) -> list[int]:
    """`state_index`から探索の始点まで前任者（-1で終わる）を辿った状態（＝Edge index）の列。"""
    edges: list[int] = []
    state = int(state_index)
    while state >= 0:
        edges.append(state)
        state = int(predecessors[state])
    return edges


def _walk_from_source(predecessors: Sequence[int] | np.ndarray, state_index: int) -> list[int]:
    """前向きの探索で、始点→`state_index`の経路を進行順に返す（前任者をたどった列を反転する）。"""
    edges = _walk_predecessors(predecessors, state_index)
    edges.reverse()
    return edges


def turn_expanded_path_from_state(tree: TurnExpandedTree, state_index: int) -> list[int]:
    """前向き木で、始点→`state_index`の経路をEdge index列（進行順）で返す。状態がそのまま
    Edge indexのため、`(parent, current)`からEdgeを引き直す必要がない。"""
    return _walk_from_source(tree.predecessor_list, state_index)


def turn_expanded_path_from_state_to_source(tree: TurnExpandedTree, state_index: int) -> list[int]:
    """`reverse=True`で作った木で、`state_index`から木の始点（目的地）までの経路を進行順で
    返す。逆向きの木では前任者を辿ることが目的地へ近づくことに当たるため、反転しない。"""
    return _walk_predecessors(tree.predecessor_list, state_index)


def turn_expanded_path_edge_indices(tree: TurnExpandedTree, target_node_index: int) -> list[int] | None:
    """木上の始点→`target_node_index`の経路をEdge index列で返す。到達不能ならNone。"""
    state = int(tree.node_best_state[target_node_index])
    if state < 0:
        return None
    return turn_expanded_path_from_state(tree, state)


@dataclass
class NodeJunction:
    """前向き木と後ろ向き木を各Nodeで繋いだ結果。配列はNode index順。"""

    # 繋いだ合計コスト（前向き＋そのNodeでのターン＋後ろ向き）。繋げないNodeはinf。
    cost: np.ndarray
    # 同じ経路の実距離（m）。繋げないNodeはNaN。
    length_m: np.ndarray
    # 同じ経路の所要時間（秒）。木が所要時間を積んでいなければNaN。
    seconds: np.ndarray
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
    所要時間が別々の経路のものになり、`(cost/seconds - 1)/P`で逆算するdifficultyが壊れる。
    """
    state = int(forward.node_best_state[destination_index])
    if state < 0:
        return
    junction.cost[destination_index] = forward.node_cost[destination_index]
    junction.length_m[destination_index] = forward.node_length_m[destination_index]
    junction.seconds[destination_index] = forward.node_seconds[destination_index]
    junction.forward_state[destination_index] = state
    junction.backward_state[destination_index] = -1


def combine_forward_backward_at_nodes(
    structure: TurnExpandedStructure,
    forward: TurnExpandedTree,
    backward: TurnExpandedTree,
    node_count: int,
) -> NodeJunction:
    """前向き木と後ろ向き木を、Nodeごとに「そこでのターンの費用を含めて」繋ぐ。

    Nodeで単に`forward.node_cost + backward.node_cost`を足すと、そのNodeを通り抜けるときの
    ターンの費用が抜ける（入る方向と出る方向の組み合わせで決まるため）。遷移（入る区間×出る
    区間の対）ごとに合計を求め、Nodeごとの最小を採る。
    """
    state_count = structure.state_count
    source = np.repeat(np.arange(state_count, dtype=np.int64), np.diff(structure.indptr))
    target = structure.target_state
    total = forward.state_cost[source] + structure.turn_seconds + backward.state_cost[target]
    length = forward.state_length_m[source] + backward.state_length_m[target]
    # 繋ぎ目のターンの待ちも所要時間に入る（コストと同じ扱い）。
    seconds_total = forward.state_seconds[source] + structure.turn_seconds + backward.state_seconds[target]
    junction_node = structure.edge_to[source]

    cost = np.full(node_count, np.inf)
    length_m = np.full(node_count, np.nan)
    seconds = np.full(node_count, np.nan)
    forward_state = np.full(node_count, -1, dtype=np.int64)
    backward_state = np.full(node_count, -1, dtype=np.int64)

    finite = np.flatnonzero(np.isfinite(total))
    if len(finite):
        order = finite[np.lexsort((total[finite], junction_node[finite]))]
        best = order[run_starts(junction_node[order])]
        best_nodes = junction_node[best]
        cost[best_nodes] = total[best]
        length_m[best_nodes] = length[best]
        seconds[best_nodes] = seconds_total[best]
        forward_state[best_nodes] = source[best]
        backward_state[best_nodes] = target[best]
    return NodeJunction(
        cost=cost, length_m=length_m, seconds=seconds,
        forward_state=forward_state, backward_state=backward_state,
    )


def _as_time_bins(caller: str, values: np.ndarray) -> np.ndarray:
    """1次元のEdge配列を`(1, 状態)`の時刻ビン形式へ揃える（2次元ならそのまま）。

    3次元以上は送出する。黙って`(1, n)`へ潰すと、後段のビン数の食い違いの検査もすり抜け、
    JITした探索が範囲外を読む。
    """
    array = np.asarray(values, dtype=EDGE_VALUE_DTYPE)
    if array.ndim > 2:
        raise ValueError(f"{caller}: expected a 1-D or 2-D array, got {array.shape}")
    return array if array.ndim == 2 else array.reshape(1, -1)


def time_bin_arrays(
    caller: str, edge_cost: np.ndarray, edge_seconds: np.ndarray, bin_seconds: float
) -> tuple[np.ndarray, np.ndarray]:
    """コスト配列と素の所要時間配列を`(時刻ビン, 状態)`へ揃え、時刻で引く契約を確かめる。

    ビンが2本以上あるとき、探索は出発からの経過時間でビンを選ぶ。そのためビンの幅が要り、
    欠けると全区間が先頭のビンに落ちて**時刻ごとの風が黙って効かなくなる**——例外もNaNも
    出さずに結果だけが変わる。

    2つの配列の形が違えば送出する。JITした探索は配列の境界を検査しないため、ビン数が
    食い違うと範囲外の読み出しになる。
    """
    cost_bins = _as_time_bins(caller, edge_cost)
    if cost_bins.shape[0] > 1:
        if not math.isfinite(bin_seconds) or bin_seconds <= 0:
            raise ValueError(
                f"{caller}: time-binned edge_cost needs a positive finite bin_seconds "
                f"(got {bin_seconds}; every state would fall into the first bin)"
            )
    seconds_bins = _as_time_bins(caller, edge_seconds)
    if seconds_bins.shape != cost_bins.shape:
        raise ValueError(
            f"{caller}: edge_seconds{seconds_bins.shape} does not match edge_cost{cost_bins.shape}"
        )
    return cost_bins, seconds_bins


@njit(cache=True, nogil=True)
def _turn_expanded_astar(
    indptr: np.ndarray,
    target_state: np.ndarray,
    turn_seconds: np.ndarray,
    edge_to: np.ndarray,
    edge_cost: np.ndarray,
    edge_seconds: np.ndarray,
    bin_seconds: float,
    node_heuristic: np.ndarray,
    origin_states: np.ndarray,
    goal_node: int,
    capacity: int,
) -> tuple[np.ndarray, int]:
    """状態＝有向区間・辺＝ターンのA*（JITコンパイル）。

    ヒープには`f = g + 目的地までの所要時間の下界`をキーとして、積んだ時点の`g`と一緒に
    積み、取り出したときに`g`が`best`より大きければ古いエントリとして捨てる。戻り値は
    前任者の配列と、目的地へ入った状態（到達不能なら-1）。

    `edge_cost`・`edge_seconds`は`(時刻ビン, 状態)`の2次元で、出発からの経過時間を
    `bin_seconds`で割ったビンの行を引く。時刻に依存しない探索はビン1本で呼ぶ。
    **状態ごとに保つラベルはコスト最小の1本だけ**（1ラベル法）——コストは時間そのものでは
    ないため、「コストは高いが早く着く」経路が後でコスト最小になる可能性を捨てる近似になる。
    """
    state_count = edge_to.shape[0]
    bin_count = edge_cost.shape[0]
    best = np.full(state_count, np.inf)
    arrival = np.full(state_count, np.inf)
    predecessor = np.full(state_count, -1, dtype=np.int64)
    heap = empty_heap(capacity, True)
    size = 0

    for i in range(origin_states.shape[0]):
        state = origin_states[i]
        g = edge_cost[0, state]
        if not np.isfinite(g) or g >= best[state]:
            continue
        best[state] = g
        arrival[state] = edge_seconds[0, state]
        f = g + node_heuristic[edge_to[state]]
        heap, size = heap_push(heap, size, f, state, g)

    goal_state = -1
    while size > 0:
        g, state, size = heap_pop(heap, size)
        if g > best[state]:
            continue
        if edge_to[state] == goal_node:
            goal_state = state
            break
        travelled = arrival[state]
        time_bin = _time_bin_of_kernel(travelled, bin_seconds, bin_count)
        for entry in range(indptr[state], indptr[state + 1]):
            nxt = target_state[entry]
            cost = edge_cost[time_bin, nxt]
            if not np.isfinite(cost):
                continue
            wait = turn_seconds[entry]
            next_g = g + cost + wait
            if next_g >= best[nxt]:
                continue
            best[nxt] = next_g
            arrival[nxt] = travelled + edge_seconds[time_bin, nxt] + wait
            predecessor[nxt] = state
            next_f = next_g + node_heuristic[edge_to[nxt]]
            heap, size = heap_push(heap, size, next_f, nxt, next_g)
    return predecessor, goal_state


def turn_expanded_shortest_path(
    structure: TurnExpandedStructure,
    edge_cost: np.ndarray,
    node_heuristic: np.ndarray,
    origin_states: np.ndarray,
    goal_node_index: int,
    edge_seconds: np.ndarray,
    bin_seconds: float = np.inf,
) -> list[int] | None:
    """起点から出る区間`origin_states`から`goal_node_index`までの最小コスト経路を、
    Edge index列（進行順）で返す。到達不能ならNone。

    **コストの単位は秒**（`edge_cost`は区間ごとの体感所要時間、ターンの待ちも秒）。
    `node_heuristic`はNodeごとの目的地までの所要時間の下界（秒）で、呼び出し元が
    「直線距離 ÷ 出せる最大速度」から作る——実経路は直線より長く、実際の速度は上限以下の
    ため下界になる。

    `edge_cost`は1次元（時刻に依存しない）か`(時刻ビン, 状態)`の2次元で、素の所要時間
    `edge_seconds`を同じ形で渡す——探索が出発からの経過時間を持ち回り、その時刻のビンから
    コストと所要時間を引く。ビンが2本以上なら幅`bin_seconds`も渡す。
    """
    cost_bins, seconds_bins = time_bin_arrays(
        "turn_expanded_shortest_path", edge_cost, edge_seconds, bin_seconds
    )
    capacity = len(origin_states) + HEAP_INITIAL_SLACK
    predecessor, goal_state = _turn_expanded_astar(
        _kernel_array(structure.indptr, SEARCH_INDEX_DTYPE), _kernel_array(structure.target_state, SEARCH_INDEX_DTYPE),
        _kernel_array(structure.turn_seconds, EDGE_VALUE_DTYPE), _kernel_array(structure.edge_to, np.int64),
        _kernel_array(cost_bins, EDGE_VALUE_DTYPE), _kernel_array(seconds_bins, EDGE_VALUE_DTYPE), float(bin_seconds),
        _kernel_array(node_heuristic, np.float64),
        _kernel_array(origin_states, np.int64), int(goal_node_index), capacity,
    )
    if goal_state < 0:
        return None
    return _walk_from_source(predecessor, goal_state)


def compile_search_kernels() -> None:
    """探索のJIT（出て戻れるNodeの集まり・一対全木・2点間探索）を、最小の道路網で1回ずつ呼んでコンパイルする。

    `@njit(cache=True)`の結果はこのファイルの隣の`__pycache__`に残り、別のプロセスはそこから読む。
    イメージの組み立て（`backend/Dockerfile`）で呼び、入れ替えたコンテナの最初のルート生成が
    コンパイルを待たないようにする。探索の入口が引数の型を揃える（`_kernel_array`）ため、ここで
    作る入力は形が合えばよい。焼くのはここがPythonから呼ぶJITだけなので、本番の経路がPythonから呼ぶJITも
    ここで呼ぶものに限る（部品は探索の中へ展開し、Pythonからは素の関数を呼ぶ）。
    """
    lazy_graph = build_lazy_road_graph(np.array([0, 1]), np.array([1, 0]), 2)
    statics = build_search_graph_statics(lazy_graph, np.ones(2))
    largest_strongly_connected_nodes(statics.csr, np.ones(2, dtype=bool))
    structure = build_turn_expanded_structure(
        statics.csr, lazy_graph, np.zeros(2), np.zeros(2), np.zeros(2, dtype=np.int64), current_turn_cost(),
        np.zeros(2, dtype=bool), np.zeros(2, dtype=np.int64),
    )
    cost = np.ones((1, 2))
    origin_states = np.array([0])
    build_turn_expanded_tree(
        structure, cost, statics.edge_length_m, origin_states, lazy_graph.node_count, edge_seconds=cost
    )
    turn_expanded_shortest_path(structure, cost, np.zeros(2), origin_states, 0, edge_seconds=cost)
