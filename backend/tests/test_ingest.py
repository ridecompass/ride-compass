"""取込の共通経路（`ingest.ingest_source`）が、トランザクションの中からの呼び出しを断ること。取込の間は派生の
作り直しが止まること。アダプタは取込の追加点（`ADAPTERS`）へ差し込んだ、行を作って返すだけのもの。

ここで見ないもの:
- アダプタが外部の形をどう読むか → `test_npa_honhyo.py`・`test_osm_pbf.py`
- 作り直しの間に取込を始めると断ること → 作り直しの側から起こす`test_derive_cli.py`
"""

from dataclasses import replace

import pytest
import pytest_asyncio
import shapely
from shapely.geometry import Point

from app.batch import derive_cli
from app.batch.ingest import (
    ADAPTERS,
    RegisteredAdapter,
    SourceRecord,
    ingest_source,
    partition_table_name,
)
from app.batch.source_profile import NoFields, SourceProfile, SourceSpec, load_source_profile
from tests.conftest import postgis_database_url, raw_connection
from tests.source_ingest import fetched_anew

# road_graph_session（conftest.py）と同じDBを使うため、.claude/rules/testing-backend.mdのパターン2どおり
# loop_scope="module"が必須。
pytestmark = pytest.mark.asyncio(loop_scope="module")

SOURCE = "ingest_probe"
POINT_WKB = shapely.to_wkb(Point(139.7, 35.6))


def _only(source: str, adapter: str) -> SourceProfile:
    return replace(load_source_profile(None), sources=(
        SourceSpec(name=source, adapter=adapter, rows=NoFields(), grid=NoFields()),))


def _adapter(read) -> RegisteredAdapter:
    return RegisteredAdapter(read=read, rows=NoFields, grid=NoFields, inputs=fetched_anew)


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def conn(road_graph_engine):
    """`road_graph_engine`に依存するのはスキーマを作らせるため。"""
    async with raw_connection() as connection:
        try:
            yield connection
        finally:
            await connection.execute(f'DROP TABLE IF EXISTS "{partition_table_name(SOURCE)}"')
            await connection.execute("DELETE FROM source_runs WHERE source = $1", SOURCE)


async def _breaks_midway(spec, profile, inputs, origin):
    yield SourceRecord(natural_key="new", geom_wkb=POINT_WKB, attrs={})
    raise OSError("配信元が途中で切れた")


async def test_ingesting_inside_a_transaction_is_refused(conn, monkeypatch):
    monkeypatch.setitem(ADAPTERS, "breaks", _adapter(_breaks_midway))
    async with conn.transaction():
        with pytest.raises(RuntimeError, match="トランザクションの外"):
            await ingest_source(conn, _only(SOURCE, "breaks"), SOURCE)


async def test_a_rebuild_is_refused_while_an_import_runs(conn, monkeypatch):
    async def rebuild_meanwhile(spec, profile, inputs, origin):
        with pytest.raises(RuntimeError, match="取込かDBのバックアップが走っている"):
            await derive_cli.run(postgis_database_url())
        yield SourceRecord(natural_key="new", geom_wkb=POINT_WKB, attrs={})

    monkeypatch.setitem(ADAPTERS, "rebuild", _adapter(rebuild_meanwhile))
    await ingest_source(conn, _only(SOURCE, "rebuild"), SOURCE)
