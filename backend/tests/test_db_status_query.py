"""`infrastructure/db_status.py`の数の読み出し——表ごとの行数と接続の数をテスト用DBで数える。

ここで見ないもの: 注意が要るかの判断 → `test_db_status_service.py`、応答への受け渡し → `test_db_status_routes.py`
"""

import pytest
from sqlalchemy import make_url, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

from app.batch.dem_tile_store import PRODUCT_PRIORITY
from app.batch.ingest import partition_table_name
from app.domain.region import BoundingBox
from app.infrastructure.db_status import DbStatusQuery
from tests.conftest import postgis_database_url
from tests.source_ingest import dem_tile_records, ingest_records, parallel_way_record


@pytest.mark.asyncio(loop_scope="module")
async def test_each_table_shows_its_rows_and_a_partitioned_one_the_rows_of_all_its_partitions(road_graph_session):
    # 分割の親や分割しない表の行数を取り違えると、管理画面で「取り込んだのに入っていない」を見誤る。
    await ingest_records("osm_way", [
        parallel_way_record(way_id)
        for way_id in (1, 2, 3)])
    area = BoundingBox(min_latitude=35.68, min_longitude=139.70, max_latitude=35.681, max_longitude=139.701)
    dem_records = dem_tile_records(PRODUCT_PRIORITY[0], 15, area, lambda lon, lat: 50.0)
    await ingest_records("dem", dem_records)

    counts = await DbStatusQuery(road_graph_session).fetch_counts()
    rows = {table.table_name: table.row_count for table in counts.tables}

    # 取込1回につき`source_runs`へ1行。
    assert [rows[partition_table_name("osm_way")], rows[partition_table_name("dem")], rows["source_features"],
            rows["source_runs"]] == [3, len(dem_records), 3 + len(dem_records), 2]


@pytest.mark.asyncio(loop_scope="module")
async def test_a_transaction_left_after_an_error_counts_as_idle_in_transaction(road_graph_engine, road_graph_session):
    # 失敗した文のあと戻されずに止まったトランザクションもロックとスナップショットを持ち続け、VACUUMを止める。
    async with road_graph_engine.connect() as stuck:
        with pytest.raises(DBAPIError):
            await stuck.execute(text("SELECT 1/0"))

        counts = await DbStatusQuery(road_graph_session).fetch_counts()

        await stuck.rollback()
    assert counts.connections.idle_in_transaction == 1


@pytest.mark.asyncio(loop_scope="module")
async def test_connections_to_other_databases_count_toward_the_connection_limit(road_graph_session):
    # 上限（max_connections）はサーバー全体の枠なので、別のDBへの接続も残り枠を減らす。
    # 並べて走る他のテストも接続を開け閉めするので、前後の差では比べない。pg_stat_activityは
    # トランザクションの中で最初に読んだ時点に固定されるので、数えたのと同じ時点のこのDBへの接続と比べる。
    other = create_async_engine(make_url(postgis_database_url()).set(database="postgres"))
    try:
        async with other.connect() as connection:
            await connection.execute(text("SELECT 1"))
            counts = await DbStatusQuery(road_graph_session).fetch_counts()
            this_database = (await road_graph_session.execute(text(
                "SELECT count(*) FROM pg_stat_activity"
                " WHERE datname = current_database() AND pid <> pg_backend_pid()"))).scalar_one()
    finally:
        await other.dispose()

    assert counts.connections.total > this_database
