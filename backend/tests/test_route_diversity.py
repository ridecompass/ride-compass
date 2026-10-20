"""`app/domain/route_diversity.py`——候補の間引き（パレートの層・重複率）。

ここで見ないもの:
- 候補ルートの並べ方・返し方 → `route_generator`側
"""
import numpy as np
import pytest

from app.domain import route_diversity

# --- overlap_ratio ---


def test_overlap_ratio_of_an_empty_candidate_is_zero():
    lengths = np.array([10.0, 10.0])
    assert route_diversity.overlap_ratio(np.array([], dtype=np.int64), np.array([0]), lengths) == 0.0


def test_overlap_ratio_weights_by_distance_not_by_edge_count():
    """共有の割合は本数ではなく距離で測る（短い区間を1本共有しても重複とは呼ばない）。"""
    lengths = np.array([10.0, 90.0])
    assert route_diversity.overlap_ratio(np.array([0, 1]), np.array([1]), lengths) == pytest.approx(0.9)


# --- pareto_layer_index ---


def test_pareto_layers_are_empty_for_no_candidates():
    layer = route_diversity.pareto_layer_index(
        np.array([]), np.array([]), quantum_a=1.0, quantum_b=1.0, max_items=3
    )
    assert len(layer) == 0


def test_pareto_layers_rank_by_how_many_candidates_dominate():
    """両指標で負けている候補ほど後ろの層へ回る。層に入れば0以上、入らなければ-1。"""
    a = np.array([1.0, 2.0, 3.0, 3.0, 2.0])
    b = np.array([10.0, 5.0, 1.0, 10.0, 10.0])
    layer = route_diversity.pareto_layer_index(a, b, quantum_a=1.0, quantum_b=1.0, max_items=5)
    assert list(layer) == [0, 0, 0, 2, 1]


def test_pareto_quantum_makes_near_equal_candidates_mutually_non_dominated():
    """粒度より小さい差は「実質同じ」として扱う。

    粒度が効かないと、1m短いだけの候補が互いに非劣解として全件残り、フィルタとして
    機能しなくなる。
    """
    a = np.array([0.0, 50.0, 500.0])
    b = np.array([0.0, 0.02, 0.5])
    layer = route_diversity.pareto_layer_index(a, b, quantum_a=200.0, quantum_b=0.1, max_items=3)
    assert list(layer) == [0, 0, 1]


def test_pareto_layers_do_not_depend_on_the_order_of_the_candidates():
    """並べ替えて渡しても各候補の層は変わらない。

    依存すると、同じ起点・同じ設定でも候補の並べ方次第で返るルート集合が変わる。
    """
    a = np.array([0.0, 0.0, 0.0, 1.0, 1.0])
    b = np.array([2.0, 0.0, 1.0, 0.0, 5.0])
    shuffle = np.array([4, 1, 3, 0, 2])
    straight = route_diversity.pareto_layer_index(a, b, quantum_a=1.0, quantum_b=1.0, max_items=2)
    # 層分けと足切りの両方が効いた状態でしか、並べ替えの影響は現れない。
    assert len(set(straight)) > 1 and -1 in straight
    shuffled = route_diversity.pareto_layer_index(
        a[shuffle], b[shuffle], quantum_a=1.0, quantum_b=1.0, max_items=2
    )
    assert list(shuffled) == [straight[i] for i in shuffle]


def test_pareto_assigns_every_candidate_when_there_are_fewer_than_requested():
    """候補が要求件数に満たないときは、全件が層に入って走査が終わる（-1が残らない）。"""
    a = np.array([1.0, 2.0, 3.0])
    b = np.array([3.0, 2.0, 1.0])
    layer = route_diversity.pareto_layer_index(a, b, quantum_a=1.0, quantum_b=1.0, max_items=10)
    assert list(layer) == [0, 0, 0]


@pytest.mark.parametrize(
    ("b", "expected"),
    [
        ([0.0, 1.0, 2.0, 3.0], [0, 1, -1, -1]),  # bがmax_items番目より後ろの候補は、どの層にも入らない
        ([0.0, 0.0, 0.0, 0.0, 0.0], [0, 0, 0, 0, 0]),  # 完全に同点の候補群は、max_items件を超えても丸ごと入る
    ],
)
def test_pareto_cuts_a_distance_step_at_max_items_counting_tie_groups_not_candidates(b, expected):
    """同じ距離段階の中は、bの小さい順にmax_items個の同点グループまでしか層に入らない。

    点単位で切ると、全方位が等距離・同難易度の地形で候補が層からこぼれ、後段の方位分散が
    働く同点グループが壊れる。
    """
    layer = route_diversity.pareto_layer_index(
        np.zeros(len(b)), np.array(b), quantum_a=1.0, quantum_b=1.0, max_items=2
    )
    assert list(layer) == expected


# --- select_diverse_by_overlap ---

DIVERSE_LENGTHS = np.array([10.0, 10.0, 10.0, 10.0, 10.0])


def test_select_diverse_rejects_max_count_beyond_the_bitmask_width():
    """採用済みの集合はuint64のビットで持つため、65件以上は表せない。黙って取りこぼさず送出する。"""
    with pytest.raises(ValueError):
        route_diversity.select_diverse_by_overlap([], lambda item: [], DIVERSE_LENGTHS, [1.0], 65)


def test_select_diverse_skips_candidates_over_the_overlap_threshold():
    """重複率が閾値を「超えた」ものだけ飛ばす（ちょうど閾値なら採用する）。"""
    edges = {"a": [0, 1], "b": [1, 2], "c": [3, 4]}
    strict = route_diversity.select_diverse_by_overlap(
        ["a", "b", "c"], edges.__getitem__, DIVERSE_LENGTHS, [0.4], 3
    )
    assert strict == ["a", "c"]
    at_threshold = route_diversity.select_diverse_by_overlap(
        ["a", "b", "c"], edges.__getitem__, DIVERSE_LENGTHS, [0.5], 3
    )
    assert at_threshold == ["a", "b", "c"]


def test_select_diverse_retries_overlap_rejects_but_not_incompatible_ones():
    """閾値を緩めたパスで再検査されるのは「重複率で飛ばした候補」だけ。

    非互換・経路無しで飛ばした候補は閾値を緩めても結果が変わらないため、再検査しない。
    """
    edges = {"a": [0, 1], "b": [0, 1], "c": [2], "d": [3], "e": None}
    selected = route_diversity.select_diverse_by_overlap(
        ["a", "b", "c", "d", "e"],
        edges.__getitem__,
        DIVERSE_LENGTHS,
        [0.5, 1.0],
        max_count=4,
        is_compatible=lambda item, chosen: item != "d",
    )
    assert selected == ["a", "c", "b"]


def test_select_diverse_compares_against_each_accepted_route_separately():
    """重複率は採用済みの1件ごとに見る（合算しない）。

    2本と半分ずつ重なる候補は、合計では全部が既出でも「どれとも半分しか重ならない」ため通る。
    """
    lengths = np.array([10.0, 10.0, 10.0, 10.0])
    edges = {"a": [0, 1], "b": [2, 3], "c": [0, 2]}
    selected = route_diversity.select_diverse_by_overlap(
        ["a", "b", "c"], edges.__getitem__, lengths, [0.6], max_count=3
    )
    assert selected == ["a", "b", "c"]


def test_select_diverse_stops_at_max_count_without_trying_looser_thresholds():
    edges = {"a": [0, 1], "b": [0, 1]}
    selected = route_diversity.select_diverse_by_overlap(
        ["a", "b"], edges.__getitem__, DIVERSE_LENGTHS, [0.5, 1.0], max_count=1
    )
    assert selected == ["a"]


def test_select_diverse_reruns_prefer_after_every_acceptance():
    """同点グループ内の試行順は、1件採用するたびに採用済みを見て決め直す。

    採用済み集合に依存する優先順（どれだけ離れているか）を、走査した候補の数ではなく
    採用件数ぶんの回数だけ計算すれば済ませるための契約。
    """
    edges = {"a": [0], "b": [1], "c": [2]}
    selected = route_diversity.select_diverse_by_overlap(
        [], edges.__getitem__, DIVERSE_LENGTHS, [1.0], max_count=3,
        tie_groups=[["a", "b", "c"]], prefer=lambda remaining, chosen: list(reversed(remaining)),
    )
    # 1度だけ決めるなら c, b, a。
    assert selected == ["c", "a", "b"]


def test_select_diverse_drops_candidates_passed_over_before_an_acceptance():
    """採用した候補より前で飛ばしたものは、そのグループの残り候補から外れる。"""
    edges = {"a": [0], "b": [1], "c": [2]}
    selected = route_diversity.select_diverse_by_overlap(
        [], edges.__getitem__, DIVERSE_LENGTHS, [1.0], max_count=3,
        is_compatible=lambda item, chosen: item != "c",
        tie_groups=[["a", "b", "c"]],
        prefer=lambda remaining, chosen: ["c", *[x for x in remaining if x != "c"]],
    )
    assert selected == ["a", "b"]
