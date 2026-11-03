"""`domain/traffic.py: direction_sql`——道のタグから、自転車が通れる向き（forward・backward・both）を決めるSQL。

式は派生の段がDBで実行するので、ここでもDBで実行して答えを見る。入力は`VALUES`で与え、表は使わない。

ここで見ないもの:
- 決めた向きを道の通行方向の表へ書くこと → 派生の段（`batch/derive_way_directions.py`）の責務
"""

import json

import pytest
from sqlalchemy import text

from app.domain import traffic

pytestmark = pytest.mark.asyncio(loop_scope="module")


async def _direction(engine, tags: dict[str, str]) -> str:
    source = "SELECT * FROM (VALUES (CAST(1 AS bigint), CAST(:tags AS jsonb))) AS t(id, tags)"
    async with engine.connect() as conn:
        result = (await conn.execute(text(traffic.direction_sql(source)), {"tags": json.dumps(tags)})).all()
    assert len(result) == 1, "道が結果から落ちたか、1本の道に向きが2つ付いた"
    return result[0].direction


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        # 当たる規則が無い道も、結果から落ちずに両方向になる。
        ({}, "both"),
        ({"oneway": " TRUE "}, "forward"),
        ({"oneway": "-1"}, "backward"),
        # 時間帯で向きが変わる等、向きを言い切れない値は一方通行にしない。
        ({"oneway": "alternating"}, "both"),
        ({"junction": "roundabout"}, "forward"),
        ({"junction": "roundabout", "oneway": "no"}, "both"),
        # 自転車は一方通行の規制の対象外（逆走できる）。
        ({"oneway": "yes", "oneway:bicycle": "no"}, "both"),
    ],
)
async def test_the_tags_decide_the_direction(road_graph_engine, tags, expected):
    assert await _direction(road_graph_engine, tags) == expected
