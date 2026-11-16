"""探索用グラフの連結性: 置いた点を寄せてよいNodeと、来た道を戻らずに行き来できるNode。

通れる区間だけでたどったときの、互いに行き来できるNodeの一番大きな集まりと、橋（除くと網が分かれる区間）で分けた
塊の木から、袋小路の奥を除いたNodeを求める。探索の費用には依らず、道路網の形と通れるかだけを読む。
"""
from collections.abc import Sequence

import numpy as np
from numba import njit
from app.domain.search_graph import CsrGraphStructure, kernel_array

def largest_strongly_connected_nodes(csr: CsrGraphStructure, passable: np.ndarray) -> np.ndarray:
    """通れる区間（`passable`、区間の番号順の真偽）だけでたどったとき、互いに行き来できるNodeの一番大きな集まり
    （最大の強連結成分。ノード番号順の真偽）。

    探索の遷移はどの区間からも同じNodeを出るどの区間へも移れる（Uターンも費用で抑えるだけで禁じない）ので、
    Nodeどうしの行き来はターンを展開しても変わらない。この集まりの中のNodeからは、集まりの中のどのNodeへも
    経路があり、集まりの外のNodeへ寄せた点は、出られないか戻れない。
    """
    component = _strong_components(*_passable_csr(csr, passable))
    if len(component) == 0:
        return np.zeros(0, dtype=bool)
    return component == int(np.argmax(np.bincount(component)))


def _passable_csr(csr: CsrGraphStructure, passable: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """JITへ渡す、CSRの行の始まり・遷移先と、遷移ごとに通れるか（`passable`は区間ごと）。型は`kernel_array`で揃える。"""
    return (
        kernel_array(csr.indptr, np.int64), kernel_array(csr.indices, np.int64),
        kernel_array(np.asarray(passable)[csr.entry_edge_index], np.bool_),
    )


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


def nodes_reached_without_retracing(
    csr: CsrGraphStructure, passable: np.ndarray, accessible: np.ndarray, terminals: Sequence[int],
) -> np.ndarray:
    """`terminals`（起点・終点）から行って帰るのに、来た道を戻るしかない区間を、`terminals`どうしと一番大きな輪の
    集まりの間を行き来する分より多く通らずに済むNode（ノード番号順の真偽）。

    来た道を戻るしかない区間は、向きを除いた道路網（通れる区間で、両端が`accessible`のもの）の橋（除くと網が分かれる
    区間）で、橋で分けた塊（2辺連結成分）とそれをつなぐ橋は木になる。この木で、`terminals`の塊と一番大きな塊をつなぐ
    最小の部分木に入る塊のNodeを返す。部分木の外の塊（行き止まりの1本道・先に輪のある袋小路）は、どこへ行くにも
    その手前の橋を往復するしかない。起点が袋小路の中にあると、一番大きな塊までの橋はどのNodeへ行き来するにも通るので
    外す理由にしない。
    """
    return _retrace_free_nodes(
        *_passable_csr(csr, passable), kernel_array(accessible, np.bool_), kernel_array(terminals, np.int64),
    )


@njit(cache=True, nogil=True)
def _undirected_adjacency(
    indptr: np.ndarray, indices: np.ndarray, passable: np.ndarray, within: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """向きを除いた区間の隣接（CSR: 行の範囲・隣のNode・向きを除いた区間の番号）。行きと帰りの両向きがある区間は1本に数える。"""
    node_count = len(indptr) - 1
    tails = np.empty(len(indices), dtype=np.int64)
    heads = np.empty(len(indices), dtype=np.int64)
    edge_count = 0
    for tail in range(node_count):
        if not within[tail]:
            continue
        for entry in range(indptr[tail], indptr[tail + 1]):
            head = indices[entry]
            if not passable[entry] or head == tail or not within[head]:
                continue
            if head < tail:
                # 逆向きの区間（各行の中は終点の昇順）が通れるなら、その区間を`head`の行で数え済み。
                lo, hi = indptr[head], indptr[head + 1]
                while lo < hi:
                    mid = (lo + hi) // 2
                    if indices[mid] < tail:
                        lo = mid + 1
                    else:
                        hi = mid
                if lo < indptr[head + 1] and indices[lo] == tail and passable[lo]:
                    continue
            tails[edge_count] = tail
            heads[edge_count] = head
            edge_count += 1
    degree = np.zeros(node_count + 1, dtype=np.int64)
    for edge in range(edge_count):
        degree[tails[edge] + 1] += 1
        degree[heads[edge] + 1] += 1
    starts = np.cumsum(degree)
    fill = starts[:-1].copy()
    neighbor = np.empty(2 * edge_count, dtype=np.int64)
    edge_of = np.empty(2 * edge_count, dtype=np.int64)
    for edge in range(2 * edge_count):
        a, b = (tails[edge // 2], heads[edge // 2]) if edge % 2 == 0 else (heads[edge // 2], tails[edge // 2])
        neighbor[fill[a]] = b
        edge_of[fill[a]] = edge // 2
        fill[a] += 1
    return starts, neighbor, edge_of


@njit(cache=True, nogil=True)
def _two_edge_components(starts: np.ndarray, neighbor: np.ndarray, edge_of: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """橋（向きを除いた区間の番号順の真偽）と、橋を除いてつながるNodeの塊の番号（ノード番号順）。Tarjanの橋の検出を
    明示のスタックへ直したもの。入ってきた区間だけを親へ戻る辺として飛ばす（同じ2点を結ぶ別の区間は輪に数える）。"""
    node_count = len(starts) - 1
    edge_count = len(neighbor) // 2
    order = np.full(node_count, -1, dtype=np.int64)
    low = np.zeros(node_count, dtype=np.int64)
    bridge = np.zeros(edge_count, dtype=np.bool_)
    call_node = np.empty(node_count, dtype=np.int64)
    call_entry = np.empty(node_count, dtype=np.int64)
    call_edge = np.empty(node_count, dtype=np.int64)
    visited = 0
    for root in range(node_count):
        if order[root] != -1:
            continue
        order[root] = visited
        low[root] = visited
        visited += 1
        call_node[0] = root
        call_entry[0] = starts[root]
        call_edge[0] = -1
        depth = 1
        while depth > 0:
            node = call_node[depth - 1]
            entry = call_entry[depth - 1]
            if entry < starts[node + 1]:
                call_entry[depth - 1] = entry + 1
                edge = edge_of[entry]
                if edge == call_edge[depth - 1]:
                    continue
                head = neighbor[entry]
                if order[head] == -1:
                    order[head] = visited
                    low[head] = visited
                    visited += 1
                    call_node[depth] = head
                    call_entry[depth] = starts[head]
                    call_edge[depth] = edge
                    depth += 1
                else:
                    low[node] = min(low[node], order[head])
                continue
            depth -= 1
            if depth > 0:
                parent = call_node[depth - 1]
                low[parent] = min(low[parent], low[node])
                if low[node] > order[parent]:
                    bridge[call_edge[depth]] = True
    component = np.full(node_count, -1, dtype=np.int64)
    stack = np.empty(node_count, dtype=np.int64)
    components = 0
    for root in range(node_count):
        if component[root] != -1:
            continue
        component[root] = components
        stack[0] = root
        size = 1
        while size > 0:
            size -= 1
            node = stack[size]
            for entry in range(starts[node], starts[node + 1]):
                head = neighbor[entry]
                if bridge[edge_of[entry]] or component[head] != -1:
                    continue
                component[head] = components
                stack[size] = head
                size += 1
        components += 1
    return bridge, component


@njit(cache=True, nogil=True)
def _retrace_free_nodes(
    indptr: np.ndarray, indices: np.ndarray, passable: np.ndarray, within: np.ndarray, terminals: np.ndarray,
) -> np.ndarray:
    """`nodes_reached_without_retracing`の本体。橋で分けた塊の木から、`terminals`の塊でも一番大きな塊でもない葉を
    削り続け、残った塊のNodeを返す。"""
    node_count = len(indptr) - 1
    starts, neighbor, edge_of = _undirected_adjacency(indptr, indices, passable, within)
    bridge, component = _two_edge_components(starts, neighbor, edge_of)
    component_count = int(component.max()) + 1 if node_count > 0 else 0
    sizes = np.zeros(component_count, dtype=np.int64)
    for node in range(node_count):
        if within[node]:
            sizes[component[node]] += 1
    kept = np.ones(component_count, dtype=np.bool_)
    if component_count == 0 or sizes.max() == 0:
        return np.zeros(node_count, dtype=np.bool_)
    pinned = np.zeros(component_count, dtype=np.bool_)
    pinned[int(np.argmax(sizes))] = True
    for terminal in terminals:
        pinned[component[terminal]] = True
    # 橋の木の隣接（塊ごとの橋の数と、橋の両端の塊）。
    bridge_ends = np.empty((2 * len(bridge), 2), dtype=np.int64)
    bridge_count = 0
    for node in range(node_count):
        for entry in range(starts[node], starts[node + 1]):
            if bridge[edge_of[entry]]:
                bridge_ends[bridge_count, 0] = component[node]
                bridge_ends[bridge_count, 1] = component[neighbor[entry]]
                bridge_count += 1
    degree = np.zeros(component_count + 1, dtype=np.int64)
    for i in range(bridge_count):
        degree[bridge_ends[i, 0] + 1] += 1
    tree_starts = np.cumsum(degree)
    fill = tree_starts[:-1].copy()
    tree_neighbor = np.empty(bridge_count, dtype=np.int64)
    for i in range(bridge_count):
        tree_neighbor[fill[bridge_ends[i, 0]]] = bridge_ends[i, 1]
        fill[bridge_ends[i, 0]] += 1
    remaining = np.diff(tree_starts)
    queue = np.empty(component_count, dtype=np.int64)
    queue_size = 0
    for c in range(component_count):
        if remaining[c] <= 1 and not pinned[c]:
            kept[c] = False
            queue[queue_size] = c
            queue_size += 1
    head_index = 0
    while head_index < queue_size:
        leaf = queue[head_index]
        head_index += 1
        for i in range(tree_starts[leaf], tree_starts[leaf + 1]):
            other = tree_neighbor[i]
            if not kept[other]:
                continue
            remaining[other] -= 1
            if remaining[other] <= 1 and not pinned[other]:
                kept[other] = False
                queue[queue_size] = other
                queue_size += 1
    result = np.zeros(node_count, dtype=np.bool_)
    for node in range(node_count):
        result[node] = within[node] and kept[component[node]]
    return result
