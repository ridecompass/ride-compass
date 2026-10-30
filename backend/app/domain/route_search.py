"""ルート探索が候補を選ぶときの判断（折返し点・復路・代替経路の選び方と並べ方、地点を寄せてよい距離）。"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

import numpy as np

from app.domain.cycling_speed import top_speed_kmh
from app.domain.difficulty import DIFFICULTY_QUANTUM, round_difficulty_array
from app.domain.evaluation import difficulty_from_cost
from app.domain.loop_routing import TracedLoop
from app.domain.geo import (
    KM_PER_DEGREE_LATITUDE,
    LatLon,
    LatLonPoint,
    haversine_distance_km_array,
    km_per_degree_longitude,
)
from app.domain.leg_costs import LegCostArrays
from app.domain.route import RouteDraft, SegmentDifficulty, route_difficulty
from app.domain.turn_structure import TurnExpandedStructure
from app.domain.route_diversity import pareto_layer_index
from app.domain.routing import time_bin_of
from app.domain.tuning import tuning_value
from app.domain.wind import cruise_hours, kmh_to_ms

# --- フロンティア方式の折返し点選定・復路探索 ---
# 折返し点・周回・帰りの選び方の値は較正値（`domain/tuning.py`の`search.*`）で、呼ばれた時点で読む。


def corridor_overlap_ratios() -> list[float]:
    """同じ道筋の候補を間引く重なりの上限と、候補が埋まらないときに緩めた上限（昇順）。

    周回の折返し点の往路どうしにも、距離なしの目的地の代替経路（前向き＋後ろ向き）どうしにも使う——どちらも
    「同じ道筋の候補が上位を占めるのを防ぐ」判断なので、片方だけ変える理由が無い。
    """
    return [
        tuning_value("search.turnaround_max_overlap_ratio"),
        tuning_value("search.turnaround_relaxed_overlap_ratio"),
    ]


def loop_max_overlap_ratio() -> float:
    """帰りまで継いだ周回どうしの、進む向きを無視した重なりの上限。"""
    return tuning_value("search.loop_max_overlap_ratio")


def loop_to_outbound_ratios() -> tuple[float, float]:
    """周回全長／往路実距離の比の見込みの下限・上限。往路は軸コスト最適経路、帰りはその往路を避けて探すため、
    帰りは往路と同程度以上に長くなる。上下限は解析的には決まらず、実分布から置く。"""
    return tuning_value("search.loop_to_outbound_ratio_min"), tuning_value("search.loop_to_outbound_ratio_max")


def distance_tolerance_km(distance_km: float) -> float:
    """全長の目標からの許容（km）。目標の距離に対する割合の較正値から決め、長い目標ほど広くする。"""
    return distance_km * tuning_value("search.distance_tolerance_ratio")


def pareto_distance_quantum_m() -> float:
    """候補選定（`pareto_layer_index`）で「実質同じ」とみなす往路の距離の粒度（m）。難易度の粒度は難易度の桁
    （`DIFFICULTY_QUANTUM`）。"""
    return tuning_value("search.pareto_distance_quantum_m")


def alternative_max_stretch() -> float:
    """距離なしの仕上げ（via-node方式）で、via-node候補（前向き木＋後ろ向き木の合成経路）の長さが、最も合成コストの
    低い経路の長さの何倍までを候補にするか。"""
    return tuning_value("search.alternative_max_stretch")

#: 利用者が置いた点（出発地・経由地・目的地）を、出て戻れるNodeへ寄せてよい上限（km）。狙いは、道のすぐそばに
#: 置いた点や、置いた先が本線から孤立した小塊・一方通行の袋だった点をすぐ近くの本線へ移すことなので、それより遠くへ
#: 動かすと利用者が指した覚えのない場所を通るルートになる（目的地の補正後の座標は`corrected_destination`として
#: 返すが、動いたことが分かっても指した場所とは別物である事実は変わらない）。
MAX_SNAP_CORRECTION_KM = 1.0

#: 学習する迂回率の実測に使う到達Nodeの、起点からの道なり距離の下限（m）。直線距離が短いNodeほど
#: 比が大きくぶれるため、起点のすぐ近くを除く（目的地ルートの前向き木が使う）。
DETOUR_RATIO_MIN_ROAD_M = 1000.0
#: 近い探索範囲をまとめる粒度。bboxを覆うこのズームのタイル集合が同じなら、学習した迂回率を
#: 共有する。z12は東京付近で1辺約8km。
DETOUR_RATIO_SHARING_ZOOM = 12


@dataclass(frozen=True)
class LengthBand:
    """候補にする全長の帯（m）。目標±許容で、帯に入る全長だけを候補にする。"""

    target_m: float
    tolerance_m: float

    @classmethod
    def from_km(cls, distance_km: float, tolerance_km: float) -> "LengthBand":
        return cls(target_m=distance_km * 1000.0, tolerance_m=tolerance_km * 1000.0)

    @property
    def lower_m(self) -> float:
        return self.target_m - self.tolerance_m

    @property
    def upper_m(self) -> float:
        return self.target_m + self.tolerance_m


def turnaround_ring_m(distance_km: float, tolerance_km: float) -> tuple[float, float, float]:
    """折返し点を探すリング（往路の実距離の範囲）の下限・上限と中心（m）。

    周回全長が目標±許容に収まるよう`[(目標-許容)/MIN, (目標+許容)/MAX]`に置き、許容が見込みの幅より狭く
    範囲が反転する場合は`(目標±許容)/比の見込みの中央`へ置き直す——下限で割ると往路が見込みの中央より長くなり、
    継いだ周回のほとんどが目標より長すぎて落ちる。

    中心（並べ方の「リング中心に近い順」の基準）は上下限の平均ではなく、目標を比の見込みの中央で割った値にする——
    許容が目標以上のとき下限が0で頭打ちになり、上下限の平均だと中心が0付近まで下がって極端に短い往路が上位に来る。
    """
    ratio_min, ratio_max = loop_to_outbound_ratios()
    band = LengthBand.from_km(distance_km, tolerance_km)
    lower_m = max(0.0, band.lower_m / ratio_min)
    upper_m = band.upper_m / ratio_max
    ratio_mid = (ratio_min + ratio_max) / 2.0
    if lower_m > upper_m:
        lower_m = max(0.0, band.lower_m / ratio_mid)
        upper_m = band.upper_m / ratio_mid
    return lower_m, upper_m, band.target_m / ratio_mid


def relay_band(
    fixed_m: float, outbound_m: np.ndarray, return_shortest_m: np.ndarray, distance_km: float, tolerance_km: float,
) -> tuple[np.ndarray, np.ndarray]:
    """距離ありで、置いた点を通るか目的地で終わるときの、中継点の帯と並べる鍵（中継点ごと）。

    中継点ごとの全長の見込み（前段`fixed_m`＋往路`outbound_m`＋帰りの最短`return_shortest_m`×帰りの比）が目標±許容に
    収まる中継点を帯に入れる。帰りは走った道を避けて探すので最短より長くなる。帰りの比は周回の比の見込み
    （`loop_to_outbound_ratios`）から1を引いたもので、周回の帰り（≈往路×(比−1)）と同じ見込みを置く（別に持つと、
    周回と目的地で帰りの見込みが食い違う）。見込みの幅が許容の幅より広い中継点は、全長を見込みの中央の1点として見る
    （`turnaround_ring_m`が範囲の反転で比の見込みの中央へ置き直すのと同じ）。届かない（長さが有限でない）中継点は帯に入らない。
    鍵は全長の見込みの中央（帰りの比の下限と上限の平均）と目標のずれ（m）で、周回のリング中心からのずれと同じく
    目標より短すぎる経路も長すぎる経路も対称に扱う。
    """
    loop_min, loop_max = loop_to_outbound_ratios()
    return_min, return_max = loop_min - 1.0, loop_max - 1.0
    band = LengthBand.from_km(distance_km, tolerance_km)
    head_m = fixed_m + np.asarray(outbound_m, dtype=float)
    shortest_m = np.asarray(return_shortest_m, dtype=float)
    low_m = head_m + shortest_m * return_min
    high_m = head_m + shortest_m * return_max
    center_m = head_m + shortest_m * (return_min + return_max) / 2.0
    too_wide = high_m - low_m > 2.0 * band.tolerance_m
    low_m = np.where(too_wide, center_m, low_m)
    high_m = np.where(too_wide, center_m, high_m)
    with np.errstate(invalid="ignore"):
        in_band = (low_m >= band.lower_m) & (high_m <= band.upper_m)
    return in_band, np.abs(center_m - band.target_m)


def turnaround_band(
    outbound_m: np.ndarray, distance_km: float, tolerance_km: float,
) -> tuple[np.ndarray, np.ndarray]:
    """経由地の無い周回の、折返し点の帯と並べる鍵（折返し点ごと）。

    往路の実距離`outbound_m`がリング（`turnaround_ring_m`）に入る点を帯に入れる。届かない（長さが有限でない）点は
    帯に入らない。鍵は往路の実距離とリング中心のずれ（m）で、周回では距離が「短いほど良い」ではなく「目標に近いほど
    良い」ため、目標より短すぎる往路（起点のすぐ近くで折り返す周回）も長すぎる往路も対称に扱う。
    """
    lower_m, upper_m, center_m = turnaround_ring_m(distance_km, tolerance_km)
    length_m = np.asarray(outbound_m, dtype=float)
    with np.errstate(invalid="ignore"):
        in_band = (length_m >= lower_m) & (length_m <= upper_m)
    return in_band, np.abs(length_m - center_m)


def retrace_penalized(costs: np.ndarray) -> np.ndarray:
    """復路探索の間に、往路の区間（と同じNode対の逆向きの区間）へ置くコスト。倍率は有限にする
    （較正値の範囲が持つ）——帰りが往路を戻るほかに道が無い区間（袋小路等）は通れる必要がある。"""
    return costs * tuning_value("search.retrace_penalty_multiplier")


@dataclass(frozen=True)
class CandidateRanking:
    """`rank_by_pareto_layers`の結果。`layer_key`・`difficulty_key`は渡した候補の位置ごと。"""

    #: 渡した候補の位置を、並べた順に`max_examined`件まで（Noneなら全件）。
    order: np.ndarray
    #: パレート層の番号（層に入らなかった候補は最大値で最後尾）。
    layer_key: np.ndarray
    #: 難易度を`DIFFICULTY_DECIMALS`の桁へ丸めた値。
    difficulty_key: np.ndarray

    def tie_groups(self, ids: np.ndarray) -> list[list[int]]:
        """並べた候補（`ids[order]`）を、層と丸めた難易度がともに等しい連続の組に分ける。

        層を見るのは、非劣解群の末尾と劣解群の先頭が同じ難易度を持つとき、両者を同点として
        混ぜると劣解が非劣解より先に試されうるため。
        """
        ranked = ids[self.order]
        group_key = np.stack([self.layer_key[self.order].astype(np.int64), self.difficulty_key[self.order]])
        return [
            group.tolist()
            for group in np.split(ranked, np.flatnonzero(np.any(np.diff(group_key, axis=1) != 0, axis=0)) + 1)
        ]


def rank_by_pareto_layers(
    ids: np.ndarray,
    distance_key: np.ndarray,
    cost: np.ndarray,
    seconds: np.ndarray,
    penalty_strength: float,
    *,
    max_items: int,
    max_examined: int | None,
    tie_by_distance: bool,
) -> CandidateRanking:
    """候補（折返し点・経由Node）を「距離の鍵」「難易度」の2指標で非優越ソートし、パレート層の順に並べる。

    難易度は`(cost/seconds - 1)/P`（コスト式の逆算）。難易度だけで並べると、難易度が距離加重
    「平均」であるために遠回りして難所を避けた候補が常に上位を占めるため、層の順を主キーにする。
    第1層だけでは2〜3件にしかならないので、`max_items`件が埋まるまで層を重ねる
    （`pareto_layer_index`）。層の中は丸めた難易度の昇順、`tie_by_distance`なら次に距離の鍵の
    昇順、最後に`ids`の昇順で決定的にする。打ち切りは**並べてから**行う——番号順で先に切ると、
    良い候補が後ろの番号に居るだけで検討から外れる。
    """
    difficulty = difficulty_from_cost(cost, seconds, penalty_strength)
    difficulty_key = round_difficulty_array(difficulty)
    layer = pareto_layer_index(
        distance_key, difficulty,
        quantum_a=pareto_distance_quantum_m(), quantum_b=DIFFICULTY_QUANTUM, max_items=max_items,
    )
    layer_key = np.where(layer >= 0, layer, np.iinfo(np.int32).max)
    keys = (ids, distance_key, difficulty_key, layer_key) if tie_by_distance else (ids, difficulty_key, layer_key)
    return CandidateRanking(np.lexsort(keys)[:max_examined], layer_key, difficulty_key)


def order_by_bearing_spread(
    remaining: Sequence[int],
    selected: list[int],
    bearing_by_node: Mapping[int, float],
    closeness_by_node: Mapping[int, float],
) -> list[int]:
    """同点グループの残り候補（Node index）を、採用済み候補との方位角距離の最小値が大きい順
    （同値はリング中心近さ`closeness`昇順、さらにNode index昇順で決定的）に並べて返す。
    採用済みが無ければリング中心近さ順。`select_diverse_by_overlap`の`prefer`として
    1件採用するたびに呼ばれるため、計算量はO(残り候補数×採用済み件数)を採用回数ぶん。
    """
    if not selected:
        return sorted(remaining, key=lambda node_index: (closeness_by_node[node_index], node_index))
    bearings = np.array([bearing_by_node[node_index] for node_index in remaining], dtype=float)
    placed = np.array([bearing_by_node[node_index] for node_index in selected], dtype=float)
    diffs = np.abs(bearings[:, None] - placed[None, :])
    diffs = np.minimum(diffs, 360.0 - diffs)
    min_dist = diffs.min(axis=1)
    closeness = np.array([closeness_by_node[node_index] for node_index in remaining], dtype=float)
    order = np.lexsort((np.asarray(remaining, dtype=np.int64), closeness, -min_dist))
    return [remaining[i] for i in order]


def turnaround_separation(
    nodes: Sequence[int], node_lat: np.ndarray, node_lon: np.ndarray, origin_lat: float
) -> Callable[[int, list[int]], bool]:
    """`nodes`のどれかが、採用済みのどれとも最小の間隔（較正値`search.min_turnaround_separation_km`）以上離れているかを返す判定。

    緯度経度を起点基準の平面km座標へ1回だけ変換し（bboxの広さなら等距円筒近似で足りる）、
    平方距離をPythonのfloat演算で比べる——候補ごとにnumpyのhaversineを呼ぶと、1回あたりの
    呼び出し費用が候補数ぶん積み上がる。`node_lat`・`node_lon`は`nodes`と同じ並び。
    """
    min_separation_sq = tuning_value("search.min_turnaround_separation_km") ** 2
    node_y = dict(zip(nodes, (node_lat * KM_PER_DEGREE_LATITUDE).tolist()))
    node_x = dict(zip(nodes, (node_lon * km_per_degree_longitude(origin_lat)).tolist()))

    def far_enough(node_index: int, selected: list[int]) -> bool:
        x, y = node_x[node_index], node_y[node_index]
        for other in selected:
            dx = x - node_x[other]
            dy = y - node_y[other]
            if dx * dx + dy * dy < min_separation_sq:
                return False
        return True

    return far_enough


def median_detour_ratio(origin: LatLon, lat: np.ndarray, lon: np.ndarray, length_m: np.ndarray) -> float:
    """起点から各Node（`lat`・`lon`）への道なり距離`length_m`と直線距離の比の中央値。
    対象が無い・直線距離0のみならNaN。"""
    if len(lat) == 0:
        return float("nan")
    straight_km = haversine_distance_km_array(lat, lon, origin)
    with np.errstate(invalid="ignore", divide="ignore"):
        ratios = np.where(straight_km > 0, np.asarray(length_m, dtype=float) / 1000 / straight_km, np.nan)
    if np.all(np.isnan(ratios)):
        return float("nan")
    return float(np.nanmedian(ratios))


def straight_distances_m(node_lat: np.ndarray, node_lon: np.ndarray, target_node: int) -> np.ndarray:
    """全Node（`node_lat`/`node_lon`と同じ行順）からノード`target_node`への直線距離（m）を
    numpyで1回だけベクトル計算する。2点間探索のA*ヒューリスティック（`heuristic_seconds`が
    秒へ直す）の素材になる。
    """
    target = LatLonPoint(float(node_lat[target_node]), float(node_lon[target_node]))
    return haversine_distance_km_array(node_lat, node_lon, target) * 1000


def heuristic_seconds(straight_m: np.ndarray, cruise_speed_kmh: float) -> np.ndarray:
    """Nodeごとの直線距離（m）を、所要時間の下界（秒）へ直す。

    実経路は直線より長く、実際の速度は走行モデルの速度の上限以下のため、これは真の
    所要時間を上回らない＝A*のヒューリスティックとして使える（admissible）。主観的割増は
    1以上の倍率のため、割増を含むコストに対しても下界であり続ける。
    """
    return np.asarray(straight_m, dtype=float) / kmh_to_ms(top_speed_kmh(cruise_speed_kmh))


def reverse_leg_assignment(leg_of_edge: list[int]) -> list[int]:
    """逆回り候補のレグ割当てを求める（先に走る側が往路配列）。

    レグは走行順に番号を振った時間帯別のコスト配列のため、Edge列の反転と同時にレグ番号自体も
    `max_leg - leg`へ振り直す必要がある（並びだけを反転させると、走り始めを帰着時刻の風、
    走り終わりを出発時刻の風で評価することになる）。
    """
    max_leg = max(leg_of_edge)
    return [max_leg - leg for leg in reversed(leg_of_edge)]


def leg_of_edge_by_half(weights: Sequence[float]) -> list[int]:
    """前向き木・後ろ向き木の境目を持たない経路の区間を、往路（0）と復路（1）へ割り当てる。

    区間より前の重み（走行秒か距離）の累積が全体の半分に届いていなければ往路、届いていれば復路
    ——レグが表す「走り始めの時刻帯／走り終わりの時刻帯」の近似が入れ替わる点として中間を採る。
    重みが全部0の経路（長さ0の区間だけ）は全部を復路にする（距離の重みが無く、どちらでも結果に効かない）。
    """
    half = sum(weights) / 2
    leg_of_edge, travelled = [], 0.0
    for weight in weights:
        leg_of_edge.append(0 if travelled < half else 1)
        travelled += weight
    return leg_of_edge


def leg_duration_hours(route_km: float, speed_kmh: float) -> float:
    """1本のレグの見込み所要時間（時間）。レグは経路の半分なので、全長の半分を巡航速度で走るとみなす。"""
    return cruise_hours(route_km / 2, speed_kmh)


@dataclass(frozen=True)
class EdgePassage:
    """経路の1区間を、探索と同じ規則でたどった時刻（`route_passages`）。"""

    # 探索がこの区間に使った時刻ビン。
    time_bin: int
    # 出発から、この区間に入るまでの秒（走行と、曲がる待ちを含む）。到達予想はこれから出す。
    elapsed_seconds: float
    # この区間を走る秒（探索と同じビンの値。有限でなければ巡航速度で走ったものとして数える）。
    seconds: float


def turn_waits_along(structure: TurnExpandedStructure, entries: Sequence[int | None]) -> list[float]:
    """経路に沿った遷移ごとのターンの待ち（秒、区間の数−1個）。遷移が無ければ待ち0。"""
    return [0.0 if entry is None else float(structure.turn_seconds[entry]) for entry in entries]


def route_passages(
    legs: Sequence[LegCostArrays],
    turn_waits: Sequence[float],
    path: Sequence[int],
    distances_m: Sequence[float],
    leg_of_edge: Sequence[int],
    speed_kmh: float,
) -> list[EdgePassage]:
    """経路を探索と同じ規則でたどり、区間ごとに時刻ビンと出発からの秒を決める。

    `path`は区間の番号（探索の行）、`turn_waits`はその遷移ごとの曲がる待ち（`turn_waits_along`）、
    `distances_m`は区間の長さ。
    探索（`domain/routing.py`の前向きDijkstra・A*）はレグの中の経過時間でビンを選ぶ: レグの最初の区間は
    ビン0、次の区間は前の区間を抜けた時点（曲がる待ちを足す前）の経過時間のビン。区間ごとの秒は、探索の
    コストの下地になっている配列（`LegCostArrays.travel_bins_lazy`、走行モデル＋停止の待ち）を
    そのビンで読む——表示の時刻と探索の時刻を別々に計算すると、片方だけ直したときに静かに食い違う。
    出発からの秒は、レグをまたいで走行と曲がる待ち（`turn_waits`）を積む。

    走行時間が有限でない区間は巡航速度で走ったものとして数える——0にすると所要時間が
    実態より短く出る。
    """
    fallback_ms = kmh_to_ms(speed_kmh)
    passages: list[EdgePassage] = []
    elapsed = 0.0
    leg_elapsed = 0.0
    # この区間へ入るときの曲がる待ち。ビンを選んだあとでレグの経過時間へ足す。
    entry_wait = 0.0
    previous_leg: int | None = None
    for i, (index, distance_m, leg_index) in enumerate(zip(path, distances_m, leg_of_edge)):
        leg = legs[leg_index]
        if leg_index != previous_leg:
            leg_elapsed = 0.0
            entry_wait = 0.0
            previous_leg = leg_index
        bin_count = leg.travel_bins_lazy.shape[0]
        time_bin = time_bin_of(leg_elapsed, leg.bin_seconds, bin_count)
        seconds = float(leg.travel_bins_lazy[time_bin, index])
        if not np.isfinite(seconds):
            seconds = distance_m / fallback_ms
        passages.append(EdgePassage(time_bin=time_bin, elapsed_seconds=elapsed, seconds=seconds))
        leg_elapsed += entry_wait + seconds
        entry_wait = turn_waits[i] if i < len(turn_waits) else 0.0
        elapsed += seconds + entry_wait
    return passages


def best_first(ranked: list[int], best: int) -> list[int]:
    """代替経路の候補の並び`ranked`の先頭へ、最良路の経由Node`best`を置く（最良路は並べ方によらず1本目）。"""
    return [best, *(node for node in ranked if node != best)]


def prefers_reverse(forward: Sequence[SegmentDifficulty], reverse: Sequence[SegmentDifficulty]) -> bool:
    """周回を逆回りで返すか。それぞれの向きのビンの難しさ（`domain/route.py: route_bins`）から畳んだ候補の合成の難しさ（`route_difficulty`）が小さい
    （走りやすい）向きを採る。逆回りが算出不能なら順回りを採る（比較不能を「逆回りの方が良い」とは読まない、安全側）。
    """
    forward_difficulty = route_difficulty(forward)
    reverse_difficulty = route_difficulty(reverse)
    return reverse_difficulty is not None and (forward_difficulty is None or reverse_difficulty < forward_difficulty)


def difficulty_order(candidate: RouteDraft) -> float:
    """候補を返す並びの鍵。周回・目的地とも総合難易度の昇順で、先頭が最も易しい候補という
    契約で配る。平均は難易度の桁へ丸めてあるので、その桁で同点になる。算出不能の候補は末尾へ回す。"""
    if candidate.overall_difficulty is None:
        return float("inf")
    return candidate.overall_difficulty.average


def keep_routes_with_baseline(
    candidates: list[RouteDraft], baseline: RouteDraft | None, max_routes: int
) -> tuple[list[RouteDraft], RouteDraft | None]:
    """目的地ルートの候補を`difficulty_order`で並べて`max_routes`件へ切り、残った候補と、印を付ける
    基準線（所要時間だけで選んだ経路）を返す。

    超えたぶんは難易度の高い側から切るが、基準線は難易度で最下位でも残す。ただし`max_routes`が1のときは
    残さない。基準線は**比べる相手があって初めて基準**であり、1本だけ返すなら比べる相手が無い。残すと返る
    唯一の候補が常に時間最短になり、軸の重みが結果に一切現れない（利用者から見ると「設定が効かない」）。
    印も同じ理由で、比べる相手が残ったときだけ付ける（1本だけなら何とも比べないので None を返す）。
    """
    ordered = sorted(candidates, key=difficulty_order)
    excess = len(ordered) - max_routes
    if excess > 0:
        keep_baseline = max_routes >= 2
        droppable = [i for i, c in enumerate(ordered) if not (keep_baseline and c is baseline)]
        dropped = set(droppable[-excess:])
        ordered = [c for i, c in enumerate(ordered) if i not in dropped]
    return ordered, baseline if len(ordered) >= 2 else None


def fits_loop_distance(loop_km: float, target_km: float, tolerance_km: float) -> bool:
    """周回の全長が目標±許容に入るか。入らない周回は候補にしない。"""
    band = LengthBand.from_km(target_km, tolerance_km)
    return band.lower_m <= loop_km * 1000.0 <= band.upper_m


def by_closeness_to_target(loops: list[TracedLoop], target_km: float) -> list[TracedLoop]:
    """周回を全長が目標距離に近い順に並べる。評価の前に並べておく——最終の並びは総合難易度で
    決まるが、同点の候補はこの順で並ぶ（重みを振った軸のデータが無く全候補が同じ難易度なら、
    結果は実質的に目標距離に近い順になる）。"""
    return sorted(loops, key=lambda loop: abs(loop.distance_km - target_km))


def alternative_via_nodes(cost: np.ndarray, length_m: np.ndarray, reachable: np.ndarray) -> tuple[int, np.ndarray]:
    """目的地ルートの最良路の経由Node（合成コスト最小）と、代替経路の候補にする経由Node
    （最良路の長さの`alternative_max_stretch`倍以内）。`reachable`が1つ以上あること。"""
    best_index = int(np.argmin(np.where(reachable, cost, np.inf)))
    within_stretch = reachable & (length_m <= float(length_m[best_index]) * alternative_max_stretch())
    return best_index, np.flatnonzero(within_stretch)
