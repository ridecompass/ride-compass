"""OSM の派生データベースの書き出し（`scripts/export_derived_database.py`・`infrastructure/derived_database_export.py`）と、
それを配る口（`GET /api/derived-database`）。

書き出しは入口（スクリプトの`run`）から打ち、配る口から ZIP を取って中身を読む。置き場（`ROOT`）はテストごとの一時ディレクトリ。
DBを使うテストは、道とノードを取込の入口から入れ、派生の作り直し（`batch/derive_cli.py: run`）で区間と材料まで作ってから書き出す
（本番で作れる行だけを使う。.claude/rules/testing-backend.md パターン8）。

ここで見ないもの:
- 材料の値そのもの（書き出しはタイルと同じ値式で読む） → `test_material_values.py`・`test_feature_materials_in_tile.py`
- 区間の切り方 → `test_derive_topology.py`
"""

import csv
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.batch import derive_cli
from app.batch.common import SOURCE_DATA_LOCK
from app.infrastructure import derived_database_export
from app.main import app
from scripts import export_derived_database
from tests.conftest import postgis_database_url, raw_connection
from tests.source_ingest import abr_prefecture_record, ingest_records, point_record, way_record

client = TestClient(app)

_ON_TEST_DB = (pytest.mark.asyncio(loop_scope="module"), pytest.mark.usefixtures("road_graph_session", "road_network_root"))


def _on_test_db(test):
    for mark in _ON_TEST_DB:
        test = mark(test)
    return test


@pytest.fixture
def export_root(monkeypatch, tmp_path):
    """書き出しの置き場を、テストごとの空の一時ディレクトリへ移したパス。"""
    root = tmp_path / "derived_database"
    monkeypatch.setattr(derived_database_export, "ROOT", root)
    return root


_BASE_LON, _BASE_LAT, _STEP = 139.70, 35.60, 0.001
_NODES = {n: (_BASE_LON + _STEP * n, _BASE_LAT + _STEP * (n % 2)) for n in (1, 2, 3, 4)}
#: 道100は道200とノード2で交わり、2区間に切れる。
_WAYS = (
    (100, [1, 2, 3], {"highway": "residential", "name": "桜通り", "surface": "asphalt"}),
    (200, [2, 4], {"highway": "primary", "ref": "1"}),
)


async def _derive() -> None:
    await ingest_records("osm_node", [point_record(n, *_NODES[n], None) for n in _NODES])
    await ingest_records("osm_way", [
        way_record(way_id, [_NODES[n] for n in node_ids], node_ids, tags) for way_id, node_ids, tags in _WAYS])
    await ingest_records("abr", [abr_prefecture_record("130001", "東京都", *_NODES[1])])
    assert await derive_cli.run(postgis_database_url()) == 0


def _download() -> zipfile.ZipFile:
    response = client.get("/api/derived-database")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    return zipfile.ZipFile(io.BytesIO(response.content))


@pytest.mark.usefixtures("export_root")
def test_nothing_to_download_before_the_first_export():
    """書き出しの前に取りに来た人へは、壊れたファイルでなく「まだ無い」を返す。"""
    assert client.get("/api/derived-database").status_code == 404


@_on_test_db
async def test_the_export_hands_every_segment_with_its_values_under_the_odbl_notice(export_root):
    """受け取った人が、道ごとの値を道・区間の鍵と形付きで、ODbL の表示と一緒に取れる。前の書き出しは残さない（置くのは最新の1つだけ）。"""
    await _derive()
    export_root.mkdir()
    stale = export_root / "ridecompass-derived-database-000000000000-r0-i0.zip"
    stale.write_bytes(b"old")

    assert await export_derived_database.run(postgis_database_url()) == 0

    archive = _download()
    readme = archive.read(derived_database_export.README_FILE).decode("utf-8")
    assert "Open Database License (ODbL) 1.0" in readme
    assert "© OpenStreetMap contributors" in readme
    rows = list(csv.DictReader(io.TextIOWrapper(archive.open(derived_database_export.DATA_FILE), encoding="utf-8")))
    by_key = {(row["osm_way_id"], row["segment_index"]): row for row in rows}
    assert sorted(by_key) == [("100", "0"), ("100", "1"), ("200", "0")]
    assert by_key[("100", "0")]["name"] == "桜通り"
    assert by_key[("100", "1")]["surface"] == "asphalt"
    assert by_key[("200", "0")]["highway"] == "primary"
    assert by_key[("200", "0")]["ref"] == "1"
    assert by_key[("100", "0")]["geometry_wkt"].startswith("LINESTRING(")
    assert float(by_key[("100", "0")]["length_m"]) > 0
    assert [path.name for path in export_root.iterdir()] == [derived_database_export.latest().name]


@_on_test_db
async def test_nothing_is_written_while_an_import_or_rebuild_holds_the_source_data(export_root):
    """取込・作り直し・バックアップの途中を書き出すと、道と値が別々の世代になる。鍵が取れなければ書かずに終える。"""
    await _derive()
    async with raw_connection() as holder:
        await holder.execute("SELECT pg_advisory_lock(hashtext($1))", SOURCE_DATA_LOCK)
        assert await export_derived_database.run(postgis_database_url()) == 0

    assert derived_database_export.latest() is None
