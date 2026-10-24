"""ルートの近くの点（停止要因・補給・立ち寄り先・事故）を、経路の上で通る距離へ並べる。

どの点がどの区間の近くにあるかは区間ごとの当たり（`RoutePointHit`）として受け取り、ここでは経路の区間の並びと
向きから、始点からの道のりへ置き直す。経路は向きつきの区間（`(osm_way_id, segment_index, forward)`）の並びで受ける。
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from app.domain.route import DISTANCE_KM_DECIMALS, RoutePoint

#: 補給・休憩ポイントと立ち寄り先を、ルートの近くの点に数える道からの距離（m）。
ROUTE_SIDE_POINT_MAX_DISTANCE_M = 100.0

#: 1回で近くの点を引ける区間の数。区間の詳しく1つ分（`domain/route.py: SEGMENT_BIN_DISTANCE_KM`）に入る区間の数より十分に大きい。
ROUTE_SIDE_POINTS_MAX_EDGES = 2000

DirectedSegment = tuple[int, int, bool]


@dataclass(frozen=True)
class RoutePointHit:
    """1つの区間の近くにある1つの点。

    `fraction`は区間の形の向き（順向き）で測った、点に最も近い位置の割合（0〜1）。`distance_m`は道から点までの地上の距離。
    `merge_group`は地図と同じく近い点を1つにまとめる行の鍵で、まとめない点はNone。`merge_within_m`は同じ行の点を
    まとめる道のりで、地図の点がまとまるのと同じ距離（派生を作り直したときの値）。`properties`は点に添えて画面へ出す値。
    """

    layer: str
    point_key: str
    merge_group: str | None
    merge_within_m: float
    properties: dict[str, Any]
    fraction: float
    distance_m: float


def points_along_route(
    edges: Sequence[DirectedSegment],
    along_km: Sequence[float],
    hits: Mapping[tuple[int, int], Sequence[RoutePointHit]],
) -> list[RoutePoint]:
    """経路が通る点を、通るたびに1つずつ、始点からの道のり（`along_km`と同じ物差し）の順に並べる。

    続けて走る別々の区間のどちらにも近い点は1回通るだけなので、道から最も近い所の1つにする。同じ区間を続けて走る
    （行き止まりで折り返す）なら、行きと帰りで2回通る。まとめる行を持つ点は、同じ行の点どうしが道のりで
    `merge_within_m`以内に連なれば、最初の1つにする。
    """
    passes: list[tuple[float, RoutePointHit]] = []
    # 点の鍵→(最後に当たった区間の位置, その通過の`passes`での位置, その通過で当たった区間)
    last_seen: dict[str, tuple[int, int, set[tuple[int, int]]]] = {}
    for index, (osm_way_id, segment_index, forward) in enumerate(edges):
        key = (osm_way_id, segment_index)
        length_km = along_km[index + 1] - along_km[index]
        continues = index > 0 and edges[index - 1][:2] != key
        for hit in hits.get(key, ()):
            fraction = hit.fraction if forward else 1.0 - hit.fraction
            km = along_km[index] + fraction * length_km
            seen = last_seen.get(hit.point_key)
            # 1回の通過が同じ区間に2度当たることはない（別の区間を挟んで同じ区間へ戻れば、2回目の通過）。
            if continues and seen is not None and seen[0] == index - 1 and key not in seen[2]:
                position, segments = seen[1], seen[2]
                if hit.distance_m < passes[position][1].distance_m:
                    passes[position] = (km, hit)
            else:
                position, segments = len(passes), set()
                passes.append((km, hit))
            segments.add(key)
            last_seen[hit.point_key] = (index, position, segments)

    passes.sort(key=lambda entry: entry[0])
    previous_in_group: dict[tuple[str, str], float] = {}
    points = []
    for km, hit in passes:
        if hit.merge_group is not None:
            group = (hit.layer, hit.merge_group)
            previous = previous_in_group.get(group)
            previous_in_group[group] = km
            if previous is not None and (km - previous) * 1000 <= hit.merge_within_m:
                continue
        points.append(RoutePoint(
            distance_km=round(km, DISTANCE_KM_DECIMALS), offset_m=round(hit.distance_m), layer=hit.layer,
            properties=hit.properties,
        ))
    return points
