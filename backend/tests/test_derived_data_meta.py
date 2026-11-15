"""`infrastructure/derived_data_meta.py`——派生データと生データの世代。

確かめるのは、表を作っただけのDBが派生の世代0の行を持ち、進めるたびに1つ進むことと、成功した取込だけが生データの世代を
進めること。後者は本物の取込を通して見る。

ここで見ないもの:
- 世代の変化を読み手がどう使うか（キャッシュの追随・配列の作り直し） → それぞれの読み手のテスト
- 入れ替えと同じトランザクションで進むこと・作り直しに使った取込の記録 → `test_derive_cli.py`
"""

import pytest

from app.infrastructure import derived_data_meta
from tests.conftest import raw_connection
from tests.source_ingest import ingest_records

pytestmark = pytest.mark.asyncio(loop_scope="module")


async def _bump_revision() -> int:
    async with raw_connection() as conn:
        return await derived_data_meta.bump_revision(conn)


async def test_creating_the_tables_starts_the_revision_at_zero_and_each_bump_advances_it(road_graph_session):
    """行は表を作るとき（`road_graph_repository.py: create_tables`）に入る。足場は行を残して世代を0へ戻すだけなので、
    行が無ければ世代を読めずに落ちる。"""
    assert (await derived_data_meta.get_revisions(road_graph_session)).derived == 0

    first = await _bump_revision()
    second = await _bump_revision()

    assert (first, second) == (1, 2)
    assert (await derived_data_meta.get_revisions(road_graph_session)).derived == 2


async def test_a_succeeded_ingest_of_any_source_advances_the_imported_revision(road_graph_session):
    """取込だけを流すと派生の世代は動かないが、派生データベースの書き出しの名前は生データの世代も持つ。成功した取込は
    ソースを問わず同じに数える（`source_models.py: succeeded_run_count`）ので、1つのソースで見る。"""
    before = (await derived_data_meta.get_revisions(road_graph_session)).imported

    await ingest_records("dem", [])

    assert (await derived_data_meta.get_revisions(road_graph_session)).imported == before + 1
