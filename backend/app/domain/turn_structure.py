"""辺基準グラフの遷移構造（状態＝有向区間、遷移＝ターン）と、遷移ごとのターンの時間（秒）・漕ぎ出しの回数・案内する曲がり。

右左折の費用はNodeに閉じず「どの区間から入ってどの区間へ出るか」で決まるため、状態をNodeではなく有向区間にする。
遷移はグラフを物理展開せず`domain/search_graph.py: CsrGraphStructure`から導く。
"""
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import IntEnum
from itertools import product

import numpy as np

from app.domain.search_graph import EDGE_VALUE_DTYPE, SEARCH_INDEX_DTYPE, CsrGraphStructure, LazyRoadGraph
from app.domain.stop_events import (
    MOVEMENTS,
    REFERENCE_PASSAGES,
    SIGNALS,
    SIZES,
    STANDINGS,
    WAIT_PASSAGES,
    Passage,
    wait_event_name,
)
from app.domain.traffic import INTERSECTION_DEGREE_THRESHOLD, MAJOR_CROSSING_MIN_RANK, NO_EVENT, StopEvent, stop_event
from app.domain.tuning import Tuning


@dataclass(frozen=True)
class TurnCostSpec:
    """曲がる所の止まる出来事（`domain/traffic.py: StopEvent`）と、直進とみなす方位差の上限（度）。

    曲がる所の時間は、曲がりの減速の層（`slow_left`・`slow_right`）と待ちの表（`waits`）の和（`domain/stop_events.py`）。
    割合・待ち・直進とみなす方位差は、いずれも走ってみて決める値のため`domain/tuning.py`が宣言する。既定を組み立てるのは
    `turn_cost`で、ここにフィールドの既定値は置かない——既定が分かれると、片方だけが変わる。
    """

    slow_left: StopEvent
    slow_right: StopEvent
    uturn: StopEvent
    straight_max_deg: float
    # 待ちの表の全部の升（信号, 大きさ, 立場, 動き）→ 出来事。基準の通り方（`REFERENCE_PASSAGES`）は何も起きない出来事。
    waits: Mapping[Passage, StopEvent]


def turn_cost(tuning: Tuning) -> TurnCostSpec:
    """較正値`tuning`で組み立てた曲がる所の出来事。"""
    return TurnCostSpec(
        slow_left=stop_event("turn", "slow_left", tuning),
        slow_right=stop_event("turn", "slow_right", tuning),
        uturn=stop_event("turn", "uturn", tuning),
        straight_max_deg=tuning.value("turn.straight_max_deg"),
        waits={**{passage: NO_EVENT for passage in REFERENCE_PASSAGES},
               **{passage: stop_event("turn", wait_event_name(passage), tuning) for passage in WAIT_PASSAGES}},
    )


@dataclass
class TurnExpandedStructure:
    """有向Edgeを状態、ターンを辺として見た構造。

    `CsrGraphStructure`と同じくEdgeの重みは持たない（リクエストごとに変わるため）。グラフを
    物理的に作り直さず、遷移は`CsrGraphStructure`から導く——ターンの費用はノード側の性質
    （方位差・信号の有無）だけで決まり、状態の数を増やさずに表せる。行＝遷移元の状態
    （区間の番号）、列＝遷移先の状態で、起点には依存しない。
    """

    state_count: int
    # 状態ごとの遷移範囲。長さ state_count + 1。
    indptr: np.ndarray
    # 遷移先の状態（区間の番号）。
    target_state: np.ndarray
    # 遷移ごとの曲がる所の時間（秒。割合 × 待ちの和）。予想時間と時刻の通過が読み、利用者の好みで変わらない。罰
    # （`PENALTY_TURNS`）は実際に失う時間ではないので入れず、遷移の費用を組む所が種類から足す（`turn_search_seconds`）。
    turn_seconds: np.ndarray
    # 遷移ごとの漕ぎ出しを、止まる出来事の回数に換えた期待値（体力の慣性の費目）。構造は利用者に依らない値だけを持ち、
    # 費用は探索の呼び手が遷移ごとの配列として渡す（`domain/routing.py`の`transition_cost`）。
    turn_kickoffs: np.ndarray
    # 遷移ごとの、案内する曲がりの種類（`TurnKind`の値）。案内しない遷移は直進。
    turn_kind: np.ndarray
    # 状態（有向Edge）の始点・終点Node index。
    edge_from: np.ndarray
    edge_to: np.ndarray
    # 状態ごとの、始点のそばの向きと終点のそばの向き（真北から時計回りの度）。曲がりを測った向きで、曲がる所の
    # 交差点に集まる道の向きも同じ値から読む。
    start_bearing_deg: np.ndarray
    end_bearing_deg: np.ndarray
    # 逆向き（転置）の遷移。目的地から遡る木が使う。最初に要求されたときだけ組む
    # （前向きだけの探索では要らないため）。
    _reverse: tuple[np.ndarray, np.ndarray, np.ndarray] | None = field(
        default=None, repr=False, compare=False
    )

    def entries_along(self, path: Sequence[int]) -> list[int | None]:
        """経路`path`（区間の番号の並び）の隣り合う区間の遷移が、遷移の列のどこにあるか（区間の数−1個）。遷移が無ければNone。"""
        entries: list[int | None] = []
        for previous, following in zip(path, path[1:]):
            start = int(self.indptr[previous])
            matches = np.flatnonzero(self.target_state[start:int(self.indptr[previous + 1])] == following)
            entries.append(start + int(matches[0]) if len(matches) else None)
        return entries

    def reverse_transitions(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """`(indptr, source_state, order)`を遷移の向きを反転した形で返す。`order`は後ろ向きの並びの各遷移が、前向きの
        遷移の列のどこか——遷移ごとの値（時間・費用）は`値[order]`で並べ替える。

        前向きの遷移「状態a→状態b、待ちw」を、後ろ向きでは「状態b→状態a、待ちw」として
        並べ替える（待ちは元の進行方向で決まるため値は変えない）。
        """
        if self._reverse is None:
            source = np.repeat(
                np.arange(self.state_count, dtype=SEARCH_INDEX_DTYPE), np.diff(self.indptr)
            )
            order = np.argsort(self.target_state, kind="stable")
            counts = np.bincount(self.target_state, minlength=self.state_count)
            indptr = np.zeros(self.state_count + 1, dtype=SEARCH_INDEX_DTYPE)
            np.cumsum(counts, out=indptr[1:])
            self._reverse = (indptr, source[order], order)
        return self._reverse


class TurnKind(IntEnum):
    """遷移の曲がりの種類。"""

    STRAIGHT = 0
    LEFT = 1
    RIGHT = 2
    UTURN = 3


def _turn_kinds(delta: np.ndarray, is_uturn: np.ndarray, branch: np.ndarray, spec: TurnCostSpec) -> np.ndarray:
    """遷移ごとの曲がりの種類（待ちの分け方）。分かれ道でない点を通る遷移は直進。分かれ道では、方位差`delta`が
    直進とみなす幅の内なら直進、外なら符号で左右を分ける（負＝反時計回り＝左折）。始点へ戻る遷移はUターン。"""
    turning = np.where(delta < 0, TurnKind.LEFT, TurnKind.RIGHT)
    kinds = np.where(np.abs(delta) <= spec.straight_max_deg, TurnKind.STRAIGHT, turning)
    kinds = np.where(branch, kinds, TurnKind.STRAIGHT)
    return np.where(is_uturn, TurnKind.UTURN, kinds).astype(np.int8)


def build_turn_expanded_structure(
    csr: CsrGraphStructure,
    lazy_graph: LazyRoadGraph,
    start_bearing_deg: np.ndarray,
    end_bearing_deg: np.ndarray,
    edge_rank: np.ndarray,
    spec: TurnCostSpec,
    node_signal_place: np.ndarray,
    node_rank: np.ndarray,
    node_branch_count: np.ndarray,
) -> TurnExpandedStructure:
    """`CsrGraphStructure`から、状態＝有向Edgeの遷移構造を組む。

    状態`e`の遷移先は「`e`の終点Nodeから出る有向Edge」で、遷移の数は
    Σ(入次数×出次数)。`e`の始点へ戻る遷移はUターンとして扱う（禁止はしない——袋小路からの
    折り返しに必要なため、罰（`PENALTY_TURNS`）で抑える）。

    曲がりは、入る区間の終点のそばの向き`end_bearing_deg`と出る区間の始点のそばの向き`start_bearing_deg`
    （どちらも区間の番号順）の差で測る。頂点の階級`node_rank`は、そこに集まる区間の一番高い階級（道路網全体で数えたもの）。区間の端から端の向きで測ると、交差点から離れた所のカーブが
    交差点の曲がりに混ざる。曲がりの減速と待ちの表の待ちは、交差点とみなす本数
    （`domain/traffic.py: INTERSECTION_DEGREE_THRESHOLD`）以上の道が集まる点（分かれ道。本数は`node_branch_count`）でだけ
    足す——分かれ道でない点は道のデータの継ぎ目で、道を選ばない。本数は進めない道
    （向こうから来る一方通行）も、部分グラフの外へ出る道も数える。進める道だけで数えると、進めない道のある交差点の
    曲がりが継ぎ目に見え、待ちも案内も消える。

    待ちの表は、信号のある交差点では1つの交差点で1回だけ引く。`node_signal_place`は頂点が入る信号の交差点の番号（入らなければ
    負）。入る区間の始点も同じ信号の交差点の分かれ道なら、同じ交差点の中を進む区間とみなして表を引かない——上下線の分かれた道を
    渡ると、信号の頂点を2つ続けて通る。始点が分かれ道でない（道のデータの継ぎ目。信号の交差点は半径で点を入れるので、継ぎ目も
    入る）なら、そこは交差点ではないので数える。曲がりの減速は、曲がった頂点で数える。

    ターンの費用に要る入力はすべて引数で受け取り、**`None`を受け取らない**。既定を持たせても
    実行時に`None`を許しても、渡し忘れた呼び出しが「待ちの表の升が引かれない」構造を
    黙って作る（例外もログも出ない）。
    """
    state_count = len(lazy_graph.edge_rows)
    edge_from = lazy_graph.edge_from
    edge_to = lazy_graph.edge_to

    indptr64 = csr.indptr.astype(np.int64)
    out_start = indptr64[edge_to]
    out_count = indptr64[edge_to + 1] - out_start
    total = int(out_count.sum())
    new_indptr = np.zeros(state_count + 1, dtype=np.int64)
    np.cumsum(out_count, out=new_indptr[1:])

    source = np.repeat(np.arange(state_count, dtype=np.int64), out_count)
    entry_index = np.repeat(out_start, out_count) + (
        np.arange(total, dtype=np.int64) - np.repeat(new_indptr[:state_count], out_count)
    )
    target_state = csr.entry_edge_index[entry_index].astype(np.int64)
    is_uturn = csr.indices[entry_index].astype(np.int64) == edge_from[source]
    delta = (start_bearing_deg[target_state] - end_bearing_deg[source] + 180.0) % 360.0 - 180.0
    branch = node_branch_count[edge_to[source]] >= INTERSECTION_DEGREE_THRESHOLD
    wait_kind = _turn_kinds(delta, is_uturn, branch, spec)

    via_node = edge_to[source]
    target_node_rank = node_rank[via_node]
    # 交差点の事実（地図だけで決まる）と、通り方の事実（入る区間で決まる）。
    place = np.asarray(node_signal_place)[via_node]
    signal = place >= 0
    large = target_node_rank >= MAJOR_CROSSING_MIN_RANK
    below = branch & ~is_uturn & (target_node_rank > edge_rank[source])
    # 同じ信号の交差点の中を進む遷移: 入る区間の始点も同じ信号の交差点の分かれ道。
    from_node = edge_from[source]
    in_place = (signal & (np.asarray(node_signal_place)[from_node] == place)
                & (node_branch_count[from_node] >= INTERSECTION_DEGREE_THRESHOLD))
    group = np.ravel_multi_index(
        (np.where(signal, _SIGNAL_KEYS.index("signal"), _SIGNAL_KEYS.index("unsignalized")),
         np.where(large, _SIZE_KEYS.index("large"), _SIZE_KEYS.index("small")),
         np.where(below, _STANDING_KEYS.index("yield"), _STANDING_KEYS.index("priority"))),
        _GROUP_SHAPE)
    group = np.where(in_place, _INSIDE, group)
    # 遷移の時間と漕ぎ出しは、曲がり方（`TurnKind`）× 事実の組の表から引く——遷移の数（探索の範囲で約200万）の配列を
    # 組み直さない。
    seconds_table, kickoffs_table = _turn_tables(spec)
    code = (wait_kind + len(TurnKind) * group).astype(np.intp)

    return TurnExpandedStructure(
        state_count=state_count, indptr=new_indptr.astype(SEARCH_INDEX_DTYPE),
        target_state=target_state.astype(SEARCH_INDEX_DTYPE),
        turn_seconds=seconds_table[code], turn_kickoffs=kickoffs_table[code],
        turn_kind=_guided_turn_kinds(wait_kind, delta, is_uturn, branch, source, state_count),
        edge_from=edge_from, edge_to=edge_to,
        start_bearing_deg=start_bearing_deg, end_bearing_deg=end_bearing_deg,
    )


#: 実際に時間を失う出来事ではなく、選ばせないための罰の曲がり。秒は探索の重みにだけ足し、予想の所要時間には入れない
#: （Uターンは、禁じると行き止まりから出られないので、罰で行き止まりのほかでは選ばせない）。
PENALTY_TURNS = frozenset({TurnKind.UTURN})


def _turn_events(spec: TurnCostSpec) -> tuple[StopEvent, ...]:
    """曲がり方ごとの、曲がりの減速の層の出来事（`TurnKind`の順。直進は出来事が無く、Uターンは罰）。"""
    return (NO_EVENT, spec.slow_left, spec.slow_right, spec.uturn)


def _penalty_table(spec: TurnCostSpec) -> np.ndarray:
    """曲がり方（`TurnKind`の値）を添字にした、罰の秒（罰の曲がりでなければ0）。"""
    return np.array([event.expected_seconds if kind in PENALTY_TURNS else 0.0
                     for kind, event in zip(TurnKind, _turn_events(spec), strict=True)], dtype=EDGE_VALUE_DTYPE)


#: 待ちの表の鍵（`domain/stop_events.py`の宣言の順）。表の添字は（信号, 大きさ, 立場）の組の並びの位置で、組の数の次の位置
#: `_INSIDE`は、表を引かない「同じ信号の交差点の中」。
_SIGNAL_KEYS = tuple(SIGNALS)
_SIZE_KEYS = tuple(SIZES)
_STANDING_KEYS = tuple(STANDINGS)
_GROUPS = tuple(product(_SIGNAL_KEYS, _SIZE_KEYS, _STANDING_KEYS))
#: 組の添字を（信号, 大きさ, 立場）の位置から出す形（`product`と同じく、後ろの鍵ほど速く回る並び）。
_GROUP_SHAPE = (len(_SIGNAL_KEYS), len(_SIZE_KEYS), len(_STANDING_KEYS))
_INSIDE = len(_GROUPS)


def _turn_tables(spec: TurnCostSpec) -> tuple[np.ndarray, np.ndarray]:
    """曲がり方（`TurnKind`の値）＋ 4 × 事実の組（`_GROUPS`の位置）を添字にした、遷移の時間（秒。罰の曲がりの罰は入れない）と
    漕ぎ出しの回数の表。時間は曲がりの減速と待ちの表の升の和で、漕ぎ出しは同じ所で1回しか起きないので大きい方だけを数える。
    Uターンと同じ交差点の中は、表を引かない。"""
    penalties = _penalty_table(spec)
    seconds, kickoffs = [], []
    for group in (*_GROUPS, None):
        for kind, slowing in zip(TurnKind, _turn_events(spec), strict=True):
            wait = (NO_EVENT if group is None or kind.name.lower() not in MOVEMENTS
                    else spec.waits[(*group, kind.name.lower())])
            seconds.append(slowing.expected_seconds - float(penalties[kind]) + wait.expected_seconds)
            kickoffs.append(max(slowing.kickoffs, wait.kickoffs))
    return np.array(seconds, dtype=EDGE_VALUE_DTYPE), np.array(kickoffs, dtype=EDGE_VALUE_DTYPE)


def turn_search_seconds(structure: TurnExpandedStructure, spec: TurnCostSpec) -> np.ndarray:
    """遷移ごとの探索の重み（秒、`structure`の遷移の並び）: 時間に、罰の曲がり（`PENALTY_TURNS`。曲がりの種類
    `TurnExpandedStructure.turn_kind`で見分ける）の罰を足したもの。所要時間だけで選ぶ経路はこれを遷移の費用にし、費用で選ぶ経路は
    これに漕ぎ出しの代償を足す（`domain/ledger_costs.py: LedgerCosts.transition_costs`）。探索ごとに組み、構造には持たない。"""
    return structure.turn_seconds + _penalty_table(spec)[structure.turn_kind]


def turn_penalties_along(structure: TurnExpandedStructure, entries: Sequence[int | None], spec: TurnCostSpec) -> list[float]:
    """経路に沿った遷移ごとの罰の秒（`entries`は`TurnExpandedStructure.entries_along`。遷移が無ければ0）。"""
    penalties = _penalty_table(spec)
    return [0.0 if entry is None else float(penalties[structure.turn_kind[entry]]) for entry in entries]


def _guided_turn_kinds(
    wait_kind: np.ndarray, delta: np.ndarray, is_uturn: np.ndarray, branch: np.ndarray, source: np.ndarray,
    state_count: int,
) -> np.ndarray:
    """遷移ごとの、案内する曲がりの種類。待ちの分け方に加え、分かれ道で直進とみなす幅の内側でも、同じ所から
    よりまっすぐに近い道へ進める遷移（浅いY字で道なりでない方へ入る所）は、方位差の符号で左右を出す。"""
    straightest = np.full(state_count, np.inf)
    np.minimum.at(straightest, source[~is_uturn], np.abs(delta[~is_uturn]))
    off_straightest = branch & (wait_kind == TurnKind.STRAIGHT) & (np.abs(delta) > straightest[source])
    return np.where(
        off_straightest, np.where(delta < 0, TurnKind.LEFT, TurnKind.RIGHT), wait_kind
    ).astype(np.int8)


@dataclass(frozen=True)
class _PathTurn:
    """経路の中の、案内する曲がり。`index`は曲がった先の区間の、経路の中の位置（`path[index]`へ入るところで曲がる）。"""

    index: int
    kind: TurnKind


def turns_along(structure: TurnExpandedStructure, entries: Sequence[int | None]) -> list[_PathTurn]:
    """経路の案内する曲がり（左折・右折・Uターン。`turn_kind`が直進でない遷移）を、経路の順に。
    `entries`は経路の遷移の位置（`TurnExpandedStructure.entries_along`）。"""
    turns: list[_PathTurn] = []
    for index, entry in enumerate(entries, start=1):
        if entry is None:
            continue
        kind = TurnKind(int(structure.turn_kind[entry]))
        if kind != TurnKind.STRAIGHT:
            turns.append(_PathTurn(index=index, kind=kind))
    return turns


def other_roads_at_turns(structure: TurnExpandedStructure, path: Sequence[int], turns: Sequence[_PathTurn]) -> list[list[float]]:
    """曲がる所ごとの、交差点に集まる道のうち経路が入る道と出る道でないものの、交差点から離れる向き（真北から時計回りの度。
    0以上360未満の昇順）。`path`は経路の区間の番号、`turns`はその経路の`turns_along`。

    道は交差点の隣のノードで1本に数える（両向きに進める道は向きごとに区間を持つ）。向こうから来る一方通行のように
    交差点から進めない道も数える——画面はこれを交差点の絵に描き、利用者が入らない道と見比べて入る道を選べるようにする。
    部分グラフの外の道は数えない。
    """
    if not turns:
        return []
    edge_from, edge_to = structure.edge_from, structure.edge_to
    nodes = [int(edge_to[path[turn.index - 1]]) for turn in turns]
    leaving_edges = np.flatnonzero(np.isin(edge_from, nodes))
    arriving_edges = np.flatnonzero(np.isin(edge_to, nodes))
    roads = []
    for turn, node in zip(turns, nodes):
        on_route = {int(edge_from[path[turn.index - 1]]), int(edge_to[path[turn.index]])}
        away: dict[int, float] = {}
        for edge in leaving_edges[edge_from[leaving_edges] == node].tolist():
            away.setdefault(int(edge_to[edge]), float(structure.start_bearing_deg[edge]) % 360.0)
        for edge in arriving_edges[edge_to[arriving_edges] == node].tolist():
            away.setdefault(int(edge_from[edge]), (float(structure.end_bearing_deg[edge]) + 180.0) % 360.0)
        roads.append(sorted(bearing for neighbor, bearing in away.items() if neighbor not in on_route))
    return roads
