"""`api/routers/material_catalog.py`——材料の値ごとの延長の割合・欠損割合（軸スタジオの管理API）。

ここで見るもの: 未知の材料を404で断ること、値ごとの延長の割合を出せない材料を`available`で伝えること、
値ごとの延長の割合に表示名を添えること、欠損割合のレポートを応答へ出すこと。

ここで見ないもの:
- 値の表示名の形（「論理名 - 物理名」・対訳の無い値） → `test_material_catalog.py`
- 値ごとの延長の割合の計算 → `test_value_distribution.py`
- 欠損割合の組み立て（並び・割合・集計の対象外） → `test_material_coverage.py`
- 認可 → `test_admin_route_authorization.py`
- DBの失敗の503 → `test_admin_db_unavailable.py`
"""


import pytest
from fastapi.testclient import TestClient

from app.api.dependencies import get_axis_preview_service, get_material_coverage_service
from app.domain.material_catalog import MATERIAL_CATALOG
from app.infrastructure.material_coverage import (
    MATERIAL_COVERAGE_EXCLUSIONS,
    MATERIAL_COVERAGE_SPECS,
    MaterialCoverageCounts,
)
from app.main import app
from app.services.axis_preview_service import AxisPreviewService, new_sample_cache
from app.services.material_coverage_service import MaterialCoverageService
from tests.admin_auth import AUTH_HEADERS

client = TestClient(app)


@pytest.fixture
def override(override_dependency):
    """経路の依存（`get_axis_preview_service`等）を、テストが置いた値へ差し替える。"""

    def _set(dependency, value):
        override_dependency(dependency, lambda: value)

    return _set


def test_an_unknown_material_is_404(admin_credentials):
    response = client.get("/api/admin/material-catalog/not_a_real_material/value-shares", headers=AUTH_HEADERS)

    assert response.status_code == 404


# --- 値ごとの延長の割合 ---


class FakeRepositoryForSample:
    """DBの代役。道の標本（`(延長m, 材料id→値)`）だけを答える。"""

    def __init__(self, sample: list[tuple[float, dict[str, object]]]):
        self._sample = sample

    async def get_accident_years_covered(self) -> int:
        return 0

    async def sample_way_material_values(self, accident_years, sample_percent, limit, bbox):
        return self._sample


def test_value_shares_list_each_value_of_the_sampled_ways_with_its_label(admin_credentials, override):
    sample = [(300.0, {"surface": "asphalt"}), (100.0, {"surface": "gravel"}), (600.0, {"surface": None})]
    override(get_axis_preview_service, AxisPreviewService(FakeRepositoryForSample(sample), new_sample_cache()))

    response = client.get("/api/admin/material-catalog/surface/value-shares", headers=AUTH_HEADERS)

    label = MATERIAL_CATALOG["surface"].value_label
    body = response.json()
    assert body["available"] is True
    assert {entry["value"]: entry["label"] for entry in body["values"]} == {
        "asphalt": label("asphalt"),
        "gravel": label("gravel"),
    }


def test_value_shares_of_a_numeric_material_are_unavailable(admin_credentials, override):
    sample = [(100.0, {"intersection_count_per_km": 4.0})]
    override(get_axis_preview_service, AxisPreviewService(FakeRepositoryForSample(sample), new_sample_cache()))

    response = client.get("/api/admin/material-catalog/intersection_count_per_km/value-shares", headers=AUTH_HEADERS)

    assert response.json() == {"available": False, "sample_ways": 0, "total_km": 0.0, "values": []}


# --- 欠損割合 ---


class FakeCoverageQuery:
    """DBの代役。集計の件数だけを答える。"""

    def __init__(self, counts: MaterialCoverageCounts):
        self._counts = counts

    async def get_material_coverage_counts(self) -> MaterialCoverageCounts:
        return self._counts


def test_coverage_returns_the_report_of_counted_and_excluded_materials(admin_credentials, override):
    counted, excluded = next(iter(MATERIAL_COVERAGE_SPECS)), next(iter(MATERIAL_COVERAGE_EXCLUSIONS))
    missing = dict.fromkeys(MATERIAL_COVERAGE_SPECS, 0) | {counted: 1}
    counts = MaterialCoverageCounts(way_total=4, edge_total=4, missing_by_material=missing)
    override(get_material_coverage_service, MaterialCoverageService(FakeCoverageQuery(counts)))

    response = client.get("/api/admin/material-catalog/coverage", headers=AUTH_HEADERS)

    entries = {entry["material_id"]: entry for entry in response.json()["materials"]}
    assert entries[counted]["missing"] == 1
    assert entries[excluded]["excluded_reason"] == MATERIAL_COVERAGE_EXCLUSIONS[excluded]
