"""`services/graph_service.py`——探索範囲を道路網全体の配列から切り出す入口。

ここで見ないもの:
- 切り出しそのもの（どの区間が範囲に入るか） → `test_road_network.py`
- 切り出した範囲で経路を探す → `test_route_generation_behavior.py`
- 切り出した区間の材料と雨の観測から組む得点 → `test_route_generation_behavior.py`

切り出しはリポジトリを読まないので、リポジトリは何も持たない代役にする（読めば落ちる）。
道路網全体の配列は`tests/route_world.py: serve_road_network`で与える。
"""

import pytest

from app.domain.region import BoundingBox
from app.services.graph_service import GraphService
from tests.east_west_network import network
from tests.route_world import serve_road_network


class NoRepository:
    """メソッドを持たない。読まれたら`AttributeError`で落ちる。"""


@pytest.fixture
def road_network(road_network_root):
    """取込範囲全体の道路網は`east_west_network.network()`。"""
    serve_road_network(road_network_root, network())


async def test_the_range_is_cut_along_the_bbox_itself(road_network):
    """切り出しはbboxそのもの——同じz12タイル（138.955〜139.043E）の中でも、bboxの外の道20は取らない。
    タイル集合は迂回率の鍵としてz12で返る。"""
    narrow = BoundingBox(min_latitude=34.99, min_longitude=138.99, max_latitude=35.01, max_longitude=139.005)
    road, tile_set = await GraphService(NoRepository()).get_search_slice(narrow)

    assert road.rows.tolist() == [0, 1]
    assert tile_set and all(zoom == 12 for zoom, _x, _y in tile_set)

