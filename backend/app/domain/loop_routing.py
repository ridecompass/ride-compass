"""周回・目的地ルートの探索結果を運ぶ型と、その欄を組む計算。

探索の実装（`services/road_graph_engine.py`）と、候補を並べる戦略
（`services/route_generator.py`）の両方が読むため、どちらにも属さないここに置く。
"""

from dataclasses import dataclass
from typing import Any


@dataclass
class LoopTurnaround:
    """`select_loop_turnarounds`が返す折返し点候補。

    `bearing`は起点から見た折返し点の方位で、表示ラベル用であり候補選定には使わない。
    `data`は復路探索に使う中間データで、型は探索の実装が決める。
    """

    bearing: int
    data: Any


@dataclass
class TracedLoop:
    """`trace_loop_from_turnaround`/`select_via_nodes`等、探索が確定した1本の経路。距離フィルタに必要な情報と、
    `evaluate_loops`が`EvaluatedRoute`を組み立てるための経路（探索用グラフの区間の番号列。
    戦略層は中身を読まない）を運ぶ。
    """

    # 出発地から見た中継点の方位。名前（`direction_label`）にだけ使い、方位を持たない経路（目的地で終わる・
    # 距離なしの代わりの道）はNone。
    bearing: int | None
    distance_km: float
    data: list[int]
    # 経路上の各Edgeがどのレグ（`services/road_graph_context.py: RoadGraphContext.legs`の添字。前段の区間ごとのレグのあとに往路・帰り）の
    # コスト配列で探索されたか。区間表示が探索と同じ配列から値を読むために使う。既定値を持たせない——省略できると、
    # 帰りまで往路の時刻で評価した区間表示が黙って出る（探索と表示が別の配列を読む）。
    leg_of_edge: list[int]
    # 置いた経由地を通る所（経路の区間の列での位置。その経由地より前の区間の数）。置いた順に並ぶ。既定値を持たせない——
    # 省略できると、経由地を通る経路が経由地の道のりを持たないまま黙って出る。
    waypoint_offsets: list[int]
    # 逆に回った経路も作って比べてよいか。出発地へ戻り、逆に回っても置いた経由地を置いた順に通るとき（経由地が
    # 1つ以下）だけ真（`road_graph_candidates.py: _build_best_candidate`）。置いた順は利用者の意図なので崩さない。
    reversible: bool


def waypoint_offsets_along(nodes: list[int], waypoint_nodes: list[int | None]) -> list[int]:
    """置いた経由地を、組んだ経路（通るノードの列`nodes`）が置いた順に通る所（`TracedLoop.waypoint_offsets`）。
    `waypoint_nodes`は置いた順の経由地を寄せたNode（寄せられなければNone）。1つでも通らなければ（乗り換えで経由地を
    飛ばした・寄せられない）空にする——並びの何番目が何番目の経由地かを崩さないため、通らない経由地だけを抜かない。"""
    offsets: list[int] = []
    start = 0
    for node in waypoint_nodes:
        if node is None or node not in nodes[start:]:
            return []
        # 同じNodeへ寄った経由地が続けば同じ所を通る（生成の前段の、長さ0の区間と同じ）。
        start = nodes.index(node, start)
        offsets.append(start)
    return offsets
