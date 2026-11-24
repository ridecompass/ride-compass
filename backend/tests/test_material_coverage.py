"""材料の欠損割合（`infrastructure/material_coverage.py`の集計・`services/material_coverage_service.py`のレポート）。

レポートの組み立ては件数を与えて見る。集計はテスト用DBで流して、道と区間の母集団ごとに欠損を数えることを見る
（全材料の判定式が同じ1回の問い合わせに並ぶので、どれかが実在しない列を読めば問い合わせごと落ちる）。配列を作るときに求める材料は、
置き場の道路網の値で数える。

ここで見ないもの:
- 材料ごとの判定式・測らない理由（カタログの宣言） → 宣言そのもので、テストに書き写さない
- どの材料も測るか測らない理由を持つか → `test_material_catalog.py`
- レポートを管理APIの応答へ出すこと・DBの失敗を503にすること → `test_material_catalog_routes.py`
"""

from datetime import datetime, timezone

import pytest

from app.batch import derive_topology
from app.infrastructure.material_coverage import (
    MATERIAL_COVERAGE_SPECS,
    MaterialCoverageCounts,
    MaterialCoverageQuery,
)
from app.services.material_coverage_service import (
    MaterialCoverageCounted,
    MaterialCoverageService,
    build_material_coverage_report,
)
from tests.conftest import raw_connection
from tests.road_network_fixture import road_network
from tests.route_world import serve_road_network
from tests.source_ingest import ingest_records, parallel_way_record

COMPUTED_AT = datetime(2026, 9, 4, tzinfo=timezone.utc)


def _counts(way_total: int = 10, edge_total: int = 4, network_edge_total: int = 4,
            **missing_overrides: int) -> MaterialCoverageCounts:
    missing = dict.fromkeys(MATERIAL_COVERAGE_SPECS, 0)
    missing.update(missing_overrides)
    return MaterialCoverageCounts(way_total=way_total, edge_total=edge_total, network_edge_total=network_edge_total,
                                  missing_by_material=missing)


# --- レポート組み立て（純関数） ---


def test_build_report_computes_ratio_against_population_total():
    report = build_material_coverage_report(
        _counts(way_total=10, edge_total=5, network_edge_total=4, surface=8, gradient_percent=3), COMPUTED_AT)
    by_id = {e.material_id: e for e in report.materials}

    surface = by_id["surface"]
    assert isinstance(surface, MaterialCoverageCounted)
    assert surface.population == "way"
    assert (surface.total, surface.missing) == (10, 8)
    assert surface.missing_ratio == pytest.approx(0.8)

    gradient = by_id["gradient_percent"]
    assert isinstance(gradient, MaterialCoverageCounted)
    assert gradient.population == "edge"
    assert (gradient.total, gradient.missing) == (4, 3)
    assert gradient.missing_ratio == pytest.approx(0.75)


def test_build_report_returns_none_ratio_when_population_is_empty():
    report = build_material_coverage_report(_counts(way_total=0, edge_total=0, network_edge_total=0), COMPUTED_AT)

    measured = [entry for entry in report.materials if isinstance(entry, MaterialCoverageCounted)]
    assert measured, "測る材料が1つも無い"
    for entry in measured:
        assert entry.total == 0
        assert entry.missing_ratio is None


# --- 集計（テスト用DB） ---


@pytest.mark.asyncio(loop_scope="module")
async def test_the_report_counts_missing_values_per_population(road_graph_session, road_network_root):
    # 道3本（路面のタグは1本だけ）を取り込んで区間へ切る。道路網の配列は区間4本で、標高は1本だけが持つ（その区間だけが勾配を持つ）。
    await ingest_records("osm_way", [
        parallel_way_record(way_id, tags)
        for way_id, tags in {1: {"surface": "asphalt"}, 2: {}, 3: {}}.items()])
    async with raw_connection() as conn:
        await derive_topology.derive(conn)
    serve_road_network(road_network_root, road_network(
        {1: (35.0, 139.0), 2: (35.0, 139.001), 3: (35.0, 139.002)},
        {(1, 0): (1, 2), (1, 1): (2, 3), (2, 0): (1, 2), (3, 0): (2, 3)}, elevation_of={(1, 0): (0.0, 1.0)}))

    report = await MaterialCoverageService(MaterialCoverageQuery(road_graph_session)).get_material_coverage()
    by_id = {e.material_id: e for e in report.materials}

    assert (report.way_total, report.edge_total) == (3, 3)
    assert [(by_id[m].total, by_id[m].missing) for m in ("surface", "gradient_percent")] == [(3, 2), (4, 3)]
