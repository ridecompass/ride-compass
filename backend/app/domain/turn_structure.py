"""辺基準グラフの遷移構造（状態＝有向区間、遷移＝ターン）と、遷移ごとのターンの時間（秒）・漕ぎ出しの回数・案内する曲がり。

右左折の費用はNodeに閉じず「どの区間から入ってどの区間へ出るか」で決まるため、状態をNodeではなく有向区間にする。
遷移はグラフを物理展開せず`domain/search_graph.py: CsrGraphStructure`から導く。
"""
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import IntEnum

import numpy as np

from app.domain.geo import LatLonPoint, bearing_between
from app.domain.search_graph import EDGE_VALUE_DTYPE, SEARCH_INDEX_DTYPE, CsrGraphStructure, LazyRoadGraph
from app.domain.stop_events import EventGroup, event_seconds_parameter_id, event_share_parameter_id
from app.domain.traffic import INTERSECTION_DEGREE_THRESHOLD, MAJOR_CROSSING_MIN_RANK, NO_EVENT, StopEvent, stop_event
from app.domain.tuning import Tuning, require_tuning


@dataclass(frozen=True)
class TurnCostSpec:
    """曲がる所の止まる出来事（`domain/traffic.py: StopEvent`）と、直進とみなす方位差の上限（度）。

    左折は止まらず減速する出来事、ほかは止まる出来事（種類は`domain/stop_events.py: STOP_EVENT_KINDS`）。
    割合・待ち・直進とみなす方位差は、いずれも走ってみて決める値のため`domain/tuning.py`が宣言する。既定を組み立てるのは
    `turn_cost`で、ここにフィールドの既定値は置かない——既定が分かれると、片方だけが変わる。
    """

    left: StopEvent
    right: StopEvent
    uturn: StopEvent
    straight_max_deg: float
    # 進入した道より上位の階級の道と交わる**信号の無い**交差点で足す出来事（横断＝直進で渡る場合と、右左折で入る
    # 場合）。信号のある交差点の待ちは停止密度の材料が所要時間へ運ぶ（`domain/traffic.py: stop_event`）ため、そちらで
    # 数え、ここでは足さない——両方で足すと同じ待ちを二重に数える（`docs/architecture/design-principles.md`構造仕様13）。
    major_crossing: StopEvent
    major_turn: StopEvent
    # 信号のある交差点で、通り方によって足す出来事（右折＝二段階右折・下の階級の道から上位の道を直進で渡る）。較正値の
    # その通り方の全体から、信号の基本の出来事を引いた差（`_beyond`）。右折の差は`right`の代わりに使う。
    signal_right: StopEvent
    minor_signal: StopEvent
    # 上下線の分かれた上位の道へ、下の階級の道から右折で入るとき、2つ目の頂点で足す差（信号での右折の全体から、1つ目の頂点で
    # 足した上位の道の横断の全体を引いたもの）。
    signal_right_after_crossing: StopEvent


def turn_cost(tuning: Tuning) -> TurnCostSpec:
    """較正値`tuning`で組み立てた曲がる所の出来事。"""
    return TurnCostSpec(
        left=stop_event("turn", "left", tuning),
        right=stop_event("turn", "right", tuning),
        uturn=stop_event("turn", "uturn", tuning),
        straight_max_deg=tuning.value("turn.straight_max_deg"),
        major_crossing=stop_event("turn", "major_crossing", tuning),
        major_turn=stop_event("turn", "major_turn", tuning),
        signal_right=_beyond("signal_right", ("stop", "signal"), tuning),
        minor_signal=_beyond("minor_signal", ("stop", "signal"), tuning),
        signal_right_after_crossing=_beyond("signal_right", ("turn", "minor_signal"), tuning),
    )


def _beyond(name: str, base: tuple[EventGroup, str], tuning: Tuning) -> StopEvent:
    """曲がる所の出来事`name`の全体（較正値）から、同じ所で既に数えた出来事`base`の全体を引いた差。差の割合と、差の
    割合 × 待ちのどちらかが負なら断る——負だと、その通り方を`base`より速く通ることになる。割合が同じで割合 × 待ちだけが
    大きい差は、割合 × 待ちの形で表せないので断る。"""
    whole, under = stop_event("turn", name, tuning), stop_event(*base, tuning)
    share = whole.share - under.share
    seconds = whole.expected_seconds - under.expected_seconds
    require_tuning(
        {event_share_parameter_id("turn", name): whole.share,
         event_seconds_parameter_id("turn", name): whole.wait_seconds,
         event_share_parameter_id(*base): under.share,
         event_seconds_parameter_id(*base): under.wait_seconds},
        share >= 0 and seconds >= 0 and (share > 0 or seconds == 0),
        f"止まる割合と割合 × 待ちが{event_seconds_parameter_id(*base)}の出来事以上（割合が同じなら割合 × 待ちも同じ）",
    )
    return StopEvent(share=share, wait_seconds=seconds / share if share > 0 else 0.0,
                     kickoffs=whole.kickoffs - under.kickoffs)


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


def edge_bearings(
    lazy_graph: LazyRoadGraph, bearing_deg: np.ndarray, node_lat: np.ndarray, node_lon: np.ndarray
) -> np.ndarray:
    """区間の番号順の方位（度）。`bearing_deg`（元の行の順、折れ線から求めた実際の向き）を
    使い、NaNの区間だけ両端のNode座標から補う。"""
    bearings = np.asarray(bearing_deg, dtype=float)[lazy_graph.edge_rows].copy()
    for index in np.flatnonzero(np.isnan(bearings)).tolist():
        tail, head = int(lazy_graph.edge_from[index]), int(lazy_graph.edge_to[index])
        bearings[index] = bearing_between(
            LatLonPoint(float(node_lat[tail]), float(node_lon[tail])),
            LatLonPoint(float(node_lat[head]), float(node_lon[head])),
        )
    return bearings


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
    node_has_signal: np.ndarray,
    node_db_rank: np.ndarray,
    node_branch_count: np.ndarray,
    edge_distance_m: np.ndarray,
    same_place_m: float,
) -> TurnExpandedStructure:
    """`CsrGraphStructure`から、状態＝有向Edgeの遷移構造を組む。

    状態`e`の遷移先は「`e`の終点Nodeから出る有向Edge」で、遷移の数は
    Σ(入次数×出次数)。`e`の始点へ戻る遷移はUターンとして扱う（禁止はしない——袋小路からの
    折り返しに必要なため、罰（`PENALTY_TURNS`）で抑える）。

    曲がりは、入る区間の終点のそばの向き`end_bearing_deg`と出る区間の始点のそばの向き`start_bearing_deg`
    （どちらも区間の番号順）の差で測る。区間の端から端の向きで測ると、交差点から離れた所のカーブが
    交差点の曲がりに混ざる。曲がりの待ちと上位の道の待ちは、交差点とみなす本数
    （`domain/traffic.py: INTERSECTION_DEGREE_THRESHOLD`）以上の道が集まる点（分かれ道。本数は`node_branch_count`）でだけ
    足す——分かれ道でない点は道のデータの継ぎ目で、道を選ばない。本数は進めない道
    （向こうから来る一方通行）も、部分グラフの外へ出る道も数える。進める道だけで数えると、進めない道のある交差点の
    曲がりが継ぎ目に見え、待ちも案内も消える。

    信号のある交差点の通り方の出来事（`TurnCostSpec.signal_right`・`minor_signal`）は、1つの交差点で1回だけ足す。入る区間の始点にも
    信号があり、区間が`same_place_m`（停止の点を1つの場所にまとめる距離。`edge_distance_m`は区間の番号順の長さ）より短ければ、
    同じ交差点の中を進む区間とみなして上位の道の横断を足さない——上下線の分かれた道を渡ると、信号の頂点を2つ続けて通る。
    その中で右折するとき（下の階級の道から、上下線の分かれた上位の道へ右折する）は、1つ目の頂点で足した横断との差だけを足す。

    ターンの費用に要る入力はすべて引数で受け取り、**`None`を受け取らない**。既定を持たせても
    実行時に`None`を許しても、渡し忘れた呼び出しが「上位の道の横断に待ちが付かない」構造を
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
    straight = wait_kind == TurnKind.STRAIGHT

    # ノードの階級は、読み込んだ部分グラフに現れる道から導く。DB側の事前集計値
    # （`node_turns.max_highway_rank`）があれば大きい方を採る——bboxの外へはみ出した
    # 上位の道は部分グラフに現れないため、導出だけでは取りこぼす。未集計の0は導出値を
    # 下回るので、バッチ未実行でも結果は変わらない。
    node_rank = np.zeros(csr.node_count, dtype=np.int64)
    np.maximum.at(node_rank, edge_to, edge_rank)
    np.maximum.at(node_rank, edge_from, edge_rank)
    node_rank = np.maximum(node_rank, node_db_rank)
    via_node = edge_to[source]
    target_node_rank = node_rank[via_node]
    signal = node_has_signal[via_node]
    major_road = target_node_rank >= MAJOR_CROSSING_MIN_RANK
    # 交差点に、入る区間より上位で、そもそも待ちの要る階級の道がある。信号の無い交差点で上位の道を横切る・入る待ちと、信号の
    # ある交差点で上位の道を直進で渡る待ちが、同じこの判定を読む。
    below_major = (target_node_rank > edge_rank[source]) & major_road
    turning = branch & ~is_uturn
    in_place = node_has_signal[edge_from[source]] & (np.asarray(edge_distance_m, dtype=np.float64)[source] < same_place_m)
    signal_first = turning & signal & ~in_place
    signal_right = turning & signal & major_road & (wait_kind == TurnKind.RIGHT)
    # 遷移の時間と漕ぎ出しは、曲がり方（`TurnKind`の4通り）× 交差点の通り方（`_Passage`）の表から引く——遷移の数（探索の範囲で
    # 約200万）の配列を組み直さない。
    passage = np.select(
        [turning & below_major & ~signal & straight,
         turning & below_major & ~signal,
         signal_first & below_major & straight,
         signal_right & ~in_place,
         signal_right & in_place & below_major],
        [_Passage.MAJOR_CROSSING, _Passage.MAJOR_TURN, _Passage.MINOR_SIGNAL, _Passage.SIGNAL_RIGHT,
         _Passage.SIGNAL_RIGHT_AFTER_CROSSING],
        _Passage.PLAIN,
    )
    seconds_table, kickoffs_table = _turn_tables(spec)
    code = (wait_kind + len(TurnKind) * passage).astype(np.intp)

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
#: 罰の曲がりの扱いを、利用者に言う文（罰は候補の負担に入る）。罰の曲がりを変えたら、ここも変える。
TURN_PENALTY_WORDING = "折り返し[Uターン]は、選ばれにくくするための分を所要時間に入れず、負担に入れます"


def _turn_events(spec: TurnCostSpec) -> tuple[StopEvent, ...]:
    """曲がり方ごとの出来事（`TurnKind`の順。直進は出来事が無い）。"""
    return (NO_EVENT, spec.left, spec.right, spec.uturn)


def _penalty_table(spec: TurnCostSpec) -> np.ndarray:
    """曲がり方（`TurnKind`の値）を添字にした、罰の秒（罰の曲がりでなければ0）。"""
    return np.array([event.expected_seconds if kind in PENALTY_TURNS else 0.0
                     for kind, event in zip(TurnKind, _turn_events(spec), strict=True)], dtype=EDGE_VALUE_DTYPE)


class _Passage(IntEnum):
    """交差点の通り方（曲がり方に重ねて足す出来事を決める）。"""

    PLAIN = 0
    # 信号の無い交差点で、上位の道を直進で横切る・右左折で入る。
    MAJOR_CROSSING = 1
    MAJOR_TURN = 2
    # 信号のある交差点で、上位の道を直進で渡る・右折する。
    MINOR_SIGNAL = 3
    SIGNAL_RIGHT = 4
    # 信号のある交差点の中（1つ目の頂点で上位の道を渡ったあと）で、上下線の分かれた上位の道へ右折する。
    SIGNAL_RIGHT_AFTER_CROSSING = 5


def _turn_tables(spec: TurnCostSpec) -> tuple[np.ndarray, np.ndarray]:
    """曲がり方（`TurnKind`の値）＋ 4 × 通り方（`_Passage`の値）を添字にした、遷移の時間（秒。罰の曲がりの罰は入れない）と
    漕ぎ出しの回数の表。通り方の待ちは曲がりの待ちに足し、漕ぎ出しは同じ所で1回しか起きないので重なる出来事の大きい方だけを
    数える。信号での右折は、右折の出来事の代わりに使う。"""
    penalties = _penalty_table(spec)
    added = {_Passage.PLAIN: NO_EVENT, _Passage.MAJOR_CROSSING: spec.major_crossing, _Passage.MAJOR_TURN: spec.major_turn,
             _Passage.MINOR_SIGNAL: spec.minor_signal, _Passage.SIGNAL_RIGHT: NO_EVENT,
             _Passage.SIGNAL_RIGHT_AFTER_CROSSING: NO_EVENT}
    signal_rights = {_Passage.SIGNAL_RIGHT: spec.signal_right,
                     _Passage.SIGNAL_RIGHT_AFTER_CROSSING: spec.signal_right_after_crossing}
    seconds, kickoffs = [], []
    for passage in _Passage:
        for kind, event in zip(TurnKind, _turn_events(spec), strict=True):
            if kind is TurnKind.RIGHT and passage in signal_rights:
                event = signal_rights[passage]
            seconds.append(event.expected_seconds - float(penalties[kind]) + added[passage].expected_seconds)
            kickoffs.append(max(event.kickoffs, added[passage].kickoffs))
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
