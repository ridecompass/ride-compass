"""最寄りの点（観測所・情報提供地点）が最寄りであり続ける範囲を、点の表ごとに一度だけ図にして引く。

図は表の中身（点の座標の並び）を鍵に持つ——表を取り直して中身が変われば、次の要求で作り直す。
"""

from collections.abc import Sequence

from cachetools import LRUCache

from app.domain.geo import LatLon
from app.domain.valid_area import NearestPointCells, ValidArea
from app.infrastructure.debug_log import log_external_call

CATEGORY = "weather:nearest-point-cells"


def new_cells_cache() -> LRUCache:
    """`nearest_point_area`へ渡すキャッシュ。点の表1つにつき1つ作り、今の表の図だけを持つ。"""
    return LRUCache(maxsize=1)


def nearest_point_area(point: LatLon, points: Sequence[LatLon], cache: LRUCache, *, table: str) -> ValidArea | None:
    """地点`point`に最も近い点が、最も近い点であり続ける範囲。`table`はログで表を見分ける名前。"""
    key = tuple((p.latitude, p.longitude) for p in points)
    with log_external_call(CATEGORY, table=table, points=len(key)) as fields:
        cells = cache.get(key)
        if cells is None:
            fields["cache"] = "miss"
            cells = NearestPointCells(points)
            cache[key] = cells
        else:
            fields["cache"] = "hit"
        return cells.area(point)
