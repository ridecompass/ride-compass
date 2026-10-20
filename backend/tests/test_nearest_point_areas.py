"""`services/nearest_point_areas.py`——最寄りの点の範囲を、点の表ごとに一度だけ図にして引く。

図を作り直したかは`/api/debug/stats`の集計（命中・外れ）で見る——図の作成は要求1件より2桁重く、表が変わらないのに
要求ごとに作り直すと、走行中の取り直しのたびにその時間を払う。

ここで見ないもの: 範囲の形（最寄りの点を含み、ほかの点を含まない）→ `test_valid_area.py`、
サービスが範囲を応答へ添えること → `test_wbgt_service.py`・`test_jma_amedas_service.py`
"""

import pytest
from shapely.geometry import Point, shape

from app.domain.route import Coordinates
from app.infrastructure.debug_log import get_stats
from app.services.nearest_point_areas import CATEGORY, nearest_point_area, new_cells_cache

# 東西に並ぶ3つの点（経度0.2度おき）。
POINTS = [
    Coordinates(latitude=35.5, longitude=139.3),
    Coordinates(latitude=35.5, longitude=139.5),
    Coordinates(latitude=35.5, longitude=139.7),
]
# 真ん中の点を東へ動かした表（取り直した表の中身が変わった）。
MOVED = [POINTS[0], Coordinates(latitude=35.5, longitude=139.6), POINTS[2]]
FIRST = Coordinates(latitude=35.5, longitude=139.45)
SECOND = Coordinates(latitude=35.52, longitude=139.52)


def _lookups() -> tuple[int, int]:
    stats = get_stats().external.get(CATEGORY)
    return (0, 0) if stats is None else (stats.cache_hits, stats.cache_misses)


@pytest.mark.parametrize(
    ("second_table", "rebuilt"),
    [
        (POINTS, False),
        (MOVED, True),
    ],
)
def test_the_cells_are_rebuilt_only_when_the_table_changes(second_table, rebuilt):
    cache = new_cells_cache()
    nearest_point_area(FIRST, POINTS, cache, table="test")
    hits, misses = _lookups()

    area = nearest_point_area(SECOND, second_table, cache, table="test")

    after_hits, after_misses = _lookups()
    assert (after_hits - hits, after_misses - misses) == ((0, 1) if rebuilt else (1, 0))
    # 範囲は2回目の表に従う——動かした表では、最寄りの点が動いた先にある。
    assert shape(area.model_dump()).contains(Point(second_table[1].longitude, second_table[1].latitude))
