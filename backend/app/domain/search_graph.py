"""探索用グラフ（区間の番号の並び）と、同じ番号を持つCSRの構造。"""
from dataclasses import dataclass

import numpy as np


@dataclass
class LazyRoadGraph:
    """探索グラフのトポロジ表現。

    Node・区間とも番号で扱う。区間の番号（`edge_rows`の添字）は探索の状態でもあり、
    `(始点, 終点)`の昇順に並ぶ。コストは持たない——リクエストごとに変わるため、探索へは別に
    合成した配列を渡す。同じノード対を結ぶ並行区間は、元の行（`edge_rows`の値）が最も小さい
    1本だけを残す。
    """

    node_count: int
    # 区間の番号→元の区間の行（探索範囲の材料・スコア行列の行）。
    edge_rows: np.ndarray
    edge_from: np.ndarray
    edge_to: np.ndarray


def build_lazy_road_graph(edge_from: np.ndarray, edge_to: np.ndarray, node_count: int) -> LazyRoadGraph:
    """区間の始点・終点（元の行の順）から`LazyRoadGraph`を組む（Hard Constraint自体は
    評価しない。除外は呼び出し元がcost=math.infで表現する）。

    並行区間の解消はコストに依らず決める——コストはリクエストごとに変わるため、トポロジを
    組む時点では決められない。
    """
    tail = np.asarray(edge_from, dtype=np.int64)
    head = np.asarray(edge_to, dtype=np.int64)
    keys = tail * node_count + head
    order = np.lexsort((np.arange(len(keys)), keys))
    kept = order[run_starts(keys[order])]
    return LazyRoadGraph(node_count=node_count, edge_rows=kept, edge_from=tail[kept], edge_to=head[kept])


def run_starts(sorted_values: np.ndarray) -> np.ndarray:
    """並べ替えた配列で、同じ値が続く並びの先頭の位置を真にした真偽配列。"""
    first = np.ones(len(sorted_values), dtype=bool)
    first[1:] = sorted_values[1:] != sorted_values[:-1]
    return first


# 探索の構造（CSR・ターン構造）の番号の列のdtype。Node数・Edge数・遷移の数はint32の値域に対して
# 桁違いに小さく、生成1回ぶんの一時的なメモリを半減できる。
SEARCH_INDEX_DTYPE = np.int32
# 区間・遷移ごとに持つ値の列（費用・所要時間・ターンの待ち・点数・材料の値）のdtype。足し合わせはfloat64で行う
# ——float32の桁で足すと、長い経路ほど誤差が積もる。
EDGE_VALUE_DTYPE = np.float32


def kernel_array(values: np.ndarray, dtype: type) -> np.ndarray:
    """JITした関数へ渡す配列を、1つの型（dtype・C順・書き込み可）へ揃える。揃っている配列は写さない。

    numbaは引数の型（dtype・並び・読み取り専用か）ごとに別々にコンパイルする。揃えずに渡すと、
    イメージの組み立てで焼いたコンパイル結果（`domain/routing.py: compile_search_kernels`）と型の違う呼び出しが、
    本番の最初のルート生成でコンパイルを払う。
    """
    array: np.ndarray = np.ascontiguousarray(values, dtype=dtype)
    return array if array.flags.writeable else array.copy()


@dataclass
class CsrGraphStructure:
    """`LazyRoadGraph`と同じNode/区間の番号を持つCSR（圧縮行格納）表現の**構造のみ**。

    Edge重み（コスト）はリクエストごとに変わるため持たず、`entry_edge_index`が
    CSRエントリ順とコスト配列の行順を結ぶ。各行の中は終点の昇順（`edge_index_between`が二分探索する）。
    """

    node_count: int
    # 標準CSR: 行（from Node index）ごとのエントリ範囲。長さnode_count+1。
    indptr: np.ndarray
    # CSRエントリ順のto Node index（各行内で昇順）。
    indices: np.ndarray
    # CSRエントリ順→区間の番号（コスト配列の並べ替えに使う）。
    entry_edge_index: np.ndarray


def _build_csr_structure(lazy_graph: LazyRoadGraph) -> CsrGraphStructure:
    """`LazyRoadGraph`（区間は`(始点, 終点)`の昇順）からCSR構造を組む。"""
    node_count = lazy_graph.node_count
    indptr = np.zeros(node_count + 1, dtype=SEARCH_INDEX_DTYPE)
    np.cumsum(np.bincount(lazy_graph.edge_from, minlength=node_count), out=indptr[1:])
    return CsrGraphStructure(
        node_count=node_count,
        indptr=indptr,
        indices=lazy_graph.edge_to.astype(SEARCH_INDEX_DTYPE),
        entry_edge_index=np.arange(len(lazy_graph.edge_to), dtype=SEARCH_INDEX_DTYPE),
    )


def edge_index_between(csr: CsrGraphStructure, tail: int, head: int) -> int | None:
    """`tail`→`head`の区間の番号。無ければNone（一方通行の逆向き等）。"""
    start, stop = int(csr.indptr[tail]), int(csr.indptr[tail + 1])
    position = start + int(np.searchsorted(csr.indices[start:stop], head))
    if position < stop and csr.indices[position] == head:
        return int(csr.entry_edge_index[position])
    return None


@dataclass
class SearchGraphStatics:
    """探索用グラフの静的な派生物一式。リクエストごとに変わる値（コスト配列）は含めない。"""

    csr: CsrGraphStructure
    # 区間の番号順の実距離（m）。一対全木に沿った実距離の積算
    # （`TurnExpandedTree.state_length_m`）と重複率（`route_diversity.py: EdgeSetOverlap`）に使う。
    edge_length_m: np.ndarray


def build_search_graph_statics(lazy_graph: LazyRoadGraph, distance_m: np.ndarray) -> SearchGraphStatics:
    """探索用の静的な派生物一式を組む。`distance_m`は元の行の順の区間の長さ。"""
    return SearchGraphStatics(
        csr=_build_csr_structure(lazy_graph),
        edge_length_m=np.asarray(distance_m, dtype=float)[lazy_graph.edge_rows],
    )
