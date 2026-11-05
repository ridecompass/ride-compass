"""探索エンジンが呼ぶ domain の判断のうち、配列だけで確かめられる計算（`domain/route_search.py`と、
`domain/route.py`の形状・標高、`domain/routing.py`の繋ぎ目の候補）。

対象は、入力を配列や値で直接与えられるもの。

- 表示値の部品（ジオメトリの連結・標高の集約と逆回りの付け替え・周回の向きの比較）
- 候補の並びの鍵（目的地の費用・周回の1kmあたりの代償の秒）
- 探索の部品（繋ぎ目の候補・同点グループの試行順・中継点の帯）
- 経路の区間ごとの時刻（`route_passages`）を、探索の木が同じ経路へ付けた所要時間と突き合わせる

ここでは見ないもの:

- 道路網から経路を作る一連の振る舞い（スナップ・周回・目的地・経由地・候補の選び方・区間の表示）
  → `test_route_generation_behavior.py`（公開の入口`RouteGenerator`から、小さな道路網で確かめる）。
  エンジンの途中状態（`RoadGraphContext`等）を手で組むテストはここに置かない——道路網の持ち方や
  組み立てを作り替えるたびに足場ごと書き直すことになり、振る舞いは何も守らない。
- 起点・終点の状態の引き方（CSR／遷移構造からの索引）→ 周回・目的地の経路が起点に戻る・目的地へ着くことで
  `test_route_generation_behavior.py`が通す。
- 標高属性の逆向き（`ElevationAttribute.reversed_as`）→ `test_attributes.py`。
- レグごとのコスト配列の合成（`domain/leg_costs.py`）→ `test_leg_costs.py`。
- 探索カーネル（`domain/routing.py`）・費用の合成（`domain/leg_costs.py`）・走行モデル
  （`domain/cycling_speed.py`）・風（`domain/wind.py`）・0次フィルタ（`domain/hard_filters.py`）
  → それぞれの持ち主のテストが持つ。

このファイルが組み立てて渡し、読むデータ型（探索構造・`EvaluatedRoute`等）は本物で作る——代役にしても
何も切り離せず、本物が変わったときに黙ってずれるだけになる。
"""


from dataclasses import replace

import numpy as np
import pytest

from app.domain.attributes import ElevationAttribute
from app.domain.graph import LeanEdge
from app.domain.route import (
    PenaltyBreakdown,
    EvaluatedRoute,
    RouteFacts,
    concat_edge_geometries,
    reverse_elevation_by_edge,
    route_elevation_gain,
)
from app.domain.route_search import (
    alternative_via_nodes,
    candidate_order,
    leg_of_edge_by_half,
    order_by_bearing_spread,
    prefers_reverse,
    rank_by_pareto_layers,
    relay_band,
    distance_tolerance_km,
    loop_to_outbound_ratios,
    reverse_leg_assignment,
    route_passages,
    transition_values_along,
    turnaround_ring_m,
)
from app.domain.leg_costs import LegCostArrays
from app.domain.routing import NodeJunction, TurnExpandedTree, add_terminal_candidate, build_turn_expanded_tree
from app.domain.tuning import TUNING_VALUES
from tests.search_graph_world import LINE_EDGES, LINE_NODES, build_all, make_graph, state_index


# --------------------------------------------------------------------------------------
# 架空の世界（本物の型を、そのテストが読む値だけ埋めて作る）
# --------------------------------------------------------------------------------------


def lean_edge(edge_id, *, geometry=None):
    """探索用グラフの区間と同じく、`geometry`を省くと空のプレースホルダになる。端のNode・長さ・DBの区間の番号は
    ここを通るテストが読まないため、どの区間にも同じ値を入れる。"""
    return LeanEdge(
        edge_id=edge_id, from_node_id="n0", to_node_id="n1",
        geometry=[] if geometry is None else geometry, distance_m=100.0,
        osm_way_id=1, segment_index=0, forward=True,
    )


def elevation(edge_id, **fields):
    """テストが名指さない欄は、端の標高と獲得・喪失標高は0m、勾配は値が取れなかった（None）として埋める。"""
    ends = {"start_elevation_m": 0.0, "end_elevation_m": 0.0, "elevation_gain_m": 0.0, "elevation_loss_m": 0.0}
    grades = dict.fromkeys(ElevationAttribute.model_fields.keys() - {"edge_id"} - ends.keys())
    return ElevationAttribute(edge_id=edge_id, **{**ends, **grades, **fields})


def turn_tree(state_count, *, node_cost, node_length_m, node_seconds, node_best_state):
    """一対全木。エンジンが読むのはNode側だけで、状態側を辿る経路の復元は各テストが差し替えるため、
    状態側はどの状態にも届いていない値（inf・NaN・-1）で埋める。"""
    return TurnExpandedTree(
        state_cost=np.full(state_count, np.inf),
        state_length_m=np.full(state_count, np.nan), state_seconds=np.full(state_count, np.nan),
        node_cost=np.asarray(node_cost, dtype=float), node_best_state=np.asarray(node_best_state, dtype=np.int64),
        node_length_m=np.asarray(node_length_m, dtype=float), node_seconds=np.asarray(node_seconds, dtype=float),
        predecessor=np.full(state_count, -1, dtype=np.int64), predecessor_list=[-1] * state_count,
    )


def draft(distance_km, duration_seconds, cost_seconds):
    """並びの鍵が読む距離・所要時間・費用だけを持つ候補。ほかの欄は空。"""
    return EvaluatedRoute(
        direction_label="", distance_km=distance_km, geometry={"type": "LineString", "coordinates": []},
        elevation_gain_m=None, segments=[], estimated_duration_seconds=duration_seconds, cost_seconds=cost_seconds,
        penalty=PenaltyBreakdown(axis_seconds={}, turn_seconds=0.0, avoidance_seconds=0.0),
        facts=RouteFacts(elevation_unknown_km=0.0, axes={}),
        wind_unavailable=False, missing_travel_data_share=None,
        edge_ids=[], edge_point_offsets=[], node_ids=[], turns=[], waypoint_distances_km=[],
    )


# --------------------------------------------------------------------------------------
# ジオメトリの連結と境界点
# --------------------------------------------------------------------------------------


def test_concat_edge_geometries_offsets_slice_back_to_each_edge():
    """隣接Edgeの境界点を二重に持たせない（線が同じ点で折り返して見える）ため、境界の位置は座標列からは
    復元できない。offsetsが各Edgeの形状を切り出せること。"""
    edges = [
        lean_edge("e1", geometry=[[35.0, 139.0], [35.1, 139.1], [35.2, 139.2]]),
        lean_edge("e2", geometry=[[35.2, 139.2], [35.3, 139.3]]),
    ]
    geometry, offsets = concat_edge_geometries(edges)
    coordinates = geometry["coordinates"]

    assert coordinates[offsets[0]:offsets[1] + 1] == [[139.0, 35.0], [139.1, 35.1], [139.2, 35.2]]
    assert coordinates[offsets[1]:offsets[2] + 1] == [[139.2, 35.2], [139.3, 35.3]]


# --------------------------------------------------------------------------------------
# 標高の集約と、逆回りの区間への付け替え
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("gains", "expected"),
    [
        ({"e1": 10.0, "e4": 2.0}, 12.0),  # 標高の無い区間は集計の母集団から外す
        ({}, None),  # 標高が1つも取れなかった経路は、0mではなく「取れなかった」として返す
    ],
)
def test_route_elevation_gain_sums_only_present_values(gains, expected):
    edges = [lean_edge("e1"), lean_edge("e2"), lean_edge("e3"), lean_edge("e4")]
    attributes = {edge_id: elevation(edge_id, elevation_gain_m=gain) for edge_id, gain in gains.items()}

    assert route_elevation_gain(edges, attributes) == expected


def test_reverse_elevation_by_edge_pairs_the_path_in_reverse_order():
    """逆方向Edgeの並びは順方向の逆。対応がずれると別の坂の値が付く。"""
    forward_edges = [lean_edge("f1"), lean_edge("f2")]
    reverse_edges = [lean_edge("r2"), lean_edge("r1")]
    attributes = {"f2": elevation("f2", elevation_gain_m=1.0, elevation_loss_m=9.0)}

    result = reverse_elevation_by_edge(forward_edges, reverse_edges, attributes)

    assert set(result) == {"r2"}
    assert result["r2"].elevation_gain_m == 9.0


# --------------------------------------------------------------------------------------
# レグ番号の振り直しと、順方向／逆回りの採否
# --------------------------------------------------------------------------------------


def test_reverse_leg_assignment_renumbers_as_well_as_reverses():
    """並びだけ反転すると、走り始めを帰着時刻の風で評価することになる。"""
    assert reverse_leg_assignment([0, 0, 0, 1, 1]) == [0, 0, 1, 1, 1]


@pytest.mark.parametrize(
    ("weights", "expected"),
    [
        ([1.0, 1.0, 1.0, 1.0], [0, 0, 1, 1]),  # 半分ちょうどから始まる区間は復路
        ([1.0, 2.0, 1.0], [0, 0, 1]),  # 半分をまたぐ区間は往路
    ],
)
def test_leg_of_edge_by_half_switches_where_the_accumulated_weight_reaches_half(weights, expected):
    """境目がずれると、帰りの時刻の風で評価する区間が変わる。"""
    assert leg_of_edge_by_half(weights) == expected


@pytest.mark.parametrize(
    ("forward_cost", "reverse_cost", "picked"),
    [(500.0, 300.0, "reverse"), (300.0, 500.0, "forward"), (400.0, 400.0, "forward")],
)
def test_prefers_reverse_takes_the_lower_cost(forward_cost, reverse_cost, picked):
    reverse = prefers_reverse(forward_cost, reverse_cost)

    assert ("reverse" if reverse else "forward") == picked


def test_loops_are_ordered_by_the_penalty_per_km_and_destinations_by_the_cost():
    """長い周回（20km・代償400秒）は短い周回（5km・代償200秒）より代償の総量が多いが、1kmあたりでは少ない。周回の一覧は
    距離の違う候補を並べるので、総量で並べると短い周回が常に先頭になる。目的地は同じ所へ着く候補どうしなので費用で並べる。"""
    long_loop, short_loop = draft(20.0, 3600.0, 4000.0), draft(5.0, 900.0, 1100.0)

    assert sorted([short_loop, long_loop], key=lambda c: candidate_order(c, loop=True)) == [long_loop, short_loop]
    assert sorted([long_loop, short_loop], key=lambda c: candidate_order(c, loop=False)) == [short_loop, long_loop]


def test_a_loop_without_a_duration_goes_last():
    unknown, known = draft(10.0, None, 0.0), draft(10.0, 1800.0, 9000.0)

    assert sorted([unknown, known], key=lambda c: candidate_order(c, loop=True)) == [known, unknown]


# --------------------------------------------------------------------------------------
# 経路の区間ごとの時刻
# --------------------------------------------------------------------------------------


def time_binned_leg(travel_bins, bin_seconds):
    """`route_passages`が読む秒の列とビンの幅だけを持つレグ。ほかの列は区間の表示が読むもので、ここでは空。"""
    travel_bins = np.asarray(travel_bins, dtype=float)
    return LegCostArrays(
        cost_lazy=travel_bins[0], travel_seconds_lazy=travel_bins[0],
        cost_bins_lazy=travel_bins, travel_bins_lazy=travel_bins, bin_seconds=bin_seconds,
        bin_times=(),
    )


def test_route_passages_reads_each_edge_in_the_time_bin_the_search_used():
    """曲がる待ちで次のビンへ押し出された時刻で区間の秒を引くと、表示の所要時間と風が、探索がその経路を
    選んだ根拠とずれる。"""
    lazy, statics, structure = build_all(make_graph(LINE_NODES, LINE_EDGES))
    structure = replace(structure, turn_seconds=np.full_like(structure.turn_seconds, 20.0))
    states = state_index(lazy)
    travel_bins = np.full((4, structure.state_count), 10.0)
    # 1つ目の区間を抜けるのは10秒（ビン0）で、曲がる待ちを足すと30秒（ビン2）になる。
    travel_bins[:, states["BC"]] = [10.0, 40.0, 70.0, 100.0]
    leg = time_binned_leg(travel_bins, bin_seconds=15.0)
    path = [states["AB"], states["BC"]]
    tree = build_turn_expanded_tree(
        structure, travel_bins, statics.edge_length_m, np.array([states["AB"]], dtype=np.int64),
        lazy.node_count, edge_seconds=travel_bins, bin_seconds=leg.bin_seconds, transition_cost=structure.turn_seconds
    )

    passages = route_passages(
        [leg], transition_values_along(structure.turn_seconds, structure.entries_along(path)), path, [100.0, 100.0], [0, 0], speed_kmh=20.0
    )

    assert passages[-1].elapsed_seconds + passages[-1].seconds == pytest.approx(tree.state_seconds[states["BC"]])


# --------------------------------------------------------------------------------------
# 目的地そのものを経由Nodeとする候補
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("node_best_state", "expected"),
    [
        # 1つでも繋ぎ目側の値が残ると、1kmあたりの代償が別経路のコストと秒と長さで求まる
        (3, (5.0, 60.0, 4.0, 3, -1)),
        # 前向きの木が着いていなければ、繋ぎ目の値に触れない
        (-1, (999.0, 111.0, 222.0, -1, 42)),
    ],
)
def test_add_terminal_candidate_copies_every_field_from_the_forward_tree(node_best_state, expected):
    junction = NodeJunction(
        cost=np.array([np.inf, 999.0]), length_m=np.array([0.0, 111.0]), seconds=np.array([0.0, 222.0]),
        forward_state=np.array([-1, -1], dtype=np.int64), backward_state=np.array([-1, 42], dtype=np.int64),
    )
    forward = turn_tree(
        4, node_cost=[0.0, 5.0], node_length_m=[0.0, 60.0], node_seconds=[0.0, 4.0],
        node_best_state=[-1, node_best_state],
    )

    add_terminal_candidate(junction, forward, 1)

    assert (junction.cost[1], junction.length_m[1], junction.seconds[1], junction.forward_state[1],
            junction.backward_state[1]) == expected


# --------------------------------------------------------------------------------------
# 同点グループ内の試行順（方位の散らし）
# --------------------------------------------------------------------------------------


def test_order_by_bearing_spread_uses_ring_centre_closeness_before_anything_is_selected():
    order = order_by_bearing_spread(
        [10, 11, 12], [], {10: 0.0, 11: 90.0, 12: 180.0}, {10: 500.0, 11: 10.0, 12: 100.0}
    )
    assert order == [11, 12, 10]


def test_order_by_bearing_spread_puts_the_most_distant_bearing_on_the_circle_first():
    """同点候補が同じ方角に並ぶと、周回一覧が「似た向き」ばかりになる。方位の差は360度を跨ぐ——単純な
    引き算だと350度と10度が「遠い」と誤判定される。"""
    order = order_by_bearing_spread(
        [10, 11], [99], {10: 10.0, 11: 90.0, 99: 350.0}, {10: 0.0, 11: 0.0}
    )
    assert order == [11, 10]


# --------------------------------------------------------------------------------------
# 候補の並べ方と、折返し点を探す範囲
# --------------------------------------------------------------------------------------


def _ranked_ids(ids, distance, penalty_per_km, *, tie_by_distance):
    """どの候補も道のり2km・所要時間100秒で、1kmあたりの代償が`penalty_per_km`秒。"""
    seconds = np.full(len(ids), 100.0)
    ranking = rank_by_pareto_layers(
        np.array(ids), np.array(distance, dtype=float), seconds + 2 * np.array(penalty_per_km), seconds,
        np.full(len(ids), 2000.0), max_items=10, max_examined=10, tie_by_distance=tie_by_distance,
    )
    return np.array(ids)[ranking.order].tolist()


def test_rank_puts_the_pareto_layer_before_the_penalty():
    """遠回りして難所を避けた候補（7）だけが上位を占めず、近くて難所を通る候補（5）も一覧に残る。
    両方に負ける候補（9）は代償が真ん中でも後ろへ回る。"""
    assert _ranked_ids([5, 7, 9], [0.0, 2000.0, 2000.0], [50.0, 10.0, 30.0], tie_by_distance=False) == [7, 5, 9]


def test_rank_treats_distances_within_the_calibrated_quantum_as_the_same(monkeypatch):
    """管理画面で距離の粒度を2kmより粗くすると、2km違いの候補は同じ距離とみなされ、代償だけで並ぶ。"""
    monkeypatch.setitem(TUNING_VALUES, "search.pareto_distance_quantum_m", 5000.0)

    assert _ranked_ids([5, 7, 9], [0.0, 2000.0, 2000.0], [50.0, 10.0, 30.0], tie_by_distance=False) == [7, 9, 5]


@pytest.mark.parametrize(("stretch", "expected"), [(1.0, [0]), (1.5, [0, 1, 2])])
def test_alternative_routes_are_at_most_the_calibrated_stretch_of_the_best(monkeypatch, stretch, expected):
    """目的地への代わりの道は、最良路（1km）の長さの較正値の倍までを候補にする。"""
    monkeypatch.setitem(TUNING_VALUES, "search.alternative_max_stretch", stretch)

    best, alternatives = alternative_via_nodes(
        np.array([1.0, 2.0, 3.0]), np.array([1000.0, 1200.0, 1400.0]), np.array([True, True, True]))
    assert (best, alternatives.tolist()) == (0, expected)


@pytest.mark.parametrize(("tie_by_distance", "expected"), [(True, [8, 3]), (False, [3, 8])])
def test_rank_breaks_ties_by_distance_only_when_asked(tie_by_distance, expected):
    """同じ層・同じ代償の中は、周回なら距離の鍵（リング中心からのずれ）の順、目的地なら番号の順。"""
    assert _ranked_ids([3, 8], [60.0, 10.0], [20.0, 20.0], tie_by_distance=tie_by_distance) == expected


@pytest.mark.parametrize("distance_km", [20.0, 50.0, 100.0])
def test_turnaround_ring_is_made_for_every_target_with_the_default_tolerance_and_estimate(distance_km):
    """既定の許容の割合と周回の全長の見込みで、受け付ける目標のどれでも、リングのどの往路から見込んだ全長も
    目標±許容に収まる。範囲が反転すると往路が見込みで全長を外れ、継いだ周回が距離の判定で落ちる。"""
    ratio_min, ratio_max = loop_to_outbound_ratios()
    tolerance_km = distance_tolerance_km(distance_km)

    lower_m, upper_m, _ = turnaround_ring_m(distance_km, tolerance_km)
    assert lower_m < upper_m
    assert lower_m * ratio_min >= (distance_km - tolerance_km) * 1000.0 - 1e-6
    assert upper_m * ratio_max <= (distance_km + tolerance_km) * 1000.0 + 1e-6


def test_turnaround_ring_is_centered_on_the_target_when_the_tolerance_is_too_narrow():
    """許容が見込みの幅より狭いと`[(目標-許容)/MIN, (目標+許容)/MAX]`が逆転し、折返し点が1つも見つからない。置き直す
    先は見込みの中央で割った目標±許容で、見込みの下限で割ると往路が長い側に偏り、周回のほとんどが長すぎて落ちる。
    既定の見込み1.8〜2.2で目標10km±0.1kmの往路は、9.9km÷2.0〜10.1km÷2.0。"""
    lower_m, upper_m, center_m = turnaround_ring_m(10.0, 0.1)
    assert (lower_m, upper_m, center_m) == pytest.approx((4950.0, 5050.0, 5000.0))


def test_turnaround_ring_center_lies_inside_the_ring():
    """折返し点の候補はリング中心に近い順に並ぶ。中心がリングの外にあると、リングの端の候補ばかりが先に試される。
    許容が狭くリングが戻る場合は、リングだけが広がり中心は動かないので、ここでは戻らない許容で見る。"""
    lower_m, upper_m, center_m = turnaround_ring_m(10.0, 2.0)
    assert lower_m <= center_m <= upper_m


def _set_loop_estimate(monkeypatch, ratio_min, ratio_max):
    monkeypatch.setitem(TUNING_VALUES, "search.loop_to_outbound_ratio_min", ratio_min)
    monkeypatch.setitem(TUNING_VALUES, "search.loop_to_outbound_ratio_max", ratio_max)


def test_turnaround_ring_follows_the_loop_length_estimate_in_effect(monkeypatch):
    """周回の全長の見込み（較正値）を管理画面で変えると、次に探すリングがその見込みで決まる。見込みを全長÷2.5に
    揃えると、目標10km±1kmのリングは9km÷2.5〜11km÷2.5で、中心は10km÷2.5。"""
    _set_loop_estimate(monkeypatch, 2.5, 2.5)

    assert turnaround_ring_m(10.0, 1.0) == pytest.approx((3600.0, 4400.0, 4000.0))


@pytest.mark.parametrize(
    ("outbound_m", "shortest_m", "in_band"),
    [
        (3000.0, 4000.0, True),  # 見込み9.0〜10.2km: 下端がちょうど目標−許容
        (2900.0, 4000.0, False),  # 下端8.9kmが目標−許容より短い
        (3000.0, 4700.0, False),  # 上端11.1kmが目標＋許容より長い
        # 見込みの幅（帰り7km×0.3）が許容の幅より広いので、全長を見込みの中央（帰り×1.15）の1点で見る。
        # 中央10.55kmは入る（幅のままだと上端11.6kmで外れる）。中央11.05kmは、下端の10.0kmが入っても外れる
        (500.0, 7000.0, True),
        (1000.0, 7000.0, False),
        (3000.0, np.nan, False),  # 終点へ届かない中継点
    ],
)
def test_relay_band_takes_relays_whose_whole_estimate_of_the_route_fits_the_distance(
    monkeypatch, outbound_m, shortest_m, in_band,
):
    """目標10km±1km、前段2km。周回の見込みを2.0〜2.3に置き、全長の見込みは前段＋往路＋帰りの最短×1.0〜1.3。
    帯から外れた中継点を選ぶと、帰りを探したあとの距離フィルタで落ち、候補が減る。"""
    _set_loop_estimate(monkeypatch, 2.0, 2.3)
    (inside,), _ = relay_band(2000.0, np.array([outbound_m]), np.array([shortest_m]), 10.0, 1.0)
    assert bool(inside) is in_band


def test_relay_band_ranks_relays_by_how_far_the_middle_of_the_estimate_is_from_the_target(monkeypatch):
    """見込みの中央（周回の見込み2.0〜2.3で、帰り×1.15）が目標から遠いほど後ろに並ぶ。短すぎる経路も長すぎる経路も
    同じに扱う。"""
    _set_loop_estimate(monkeypatch, 2.0, 2.3)
    _, closeness_m = relay_band(2000.0, np.array([3000.0, 3000.0]), np.array([4000.0, 4000.0 + 800.0 / 1.15]), 10.0, 1.0)
    assert closeness_m == pytest.approx([400.0, 400.0])
