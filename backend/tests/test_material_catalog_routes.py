"""`api/routers/material_catalog.py`——材料の欠損割合の管理API。欠損割合のレポートを応答へ出すこと。

ここで見ないもの:
- 欠損割合の組み立て（並び・割合・集計の対象外） → `test_material_coverage.py`
- 認可 → `test_admin_route_authorization.py`
"""


import pytest
from fastapi.testclient import TestClient

from app.api.dependencies import get_material_coverage_service
from app.infrastructure.material_coverage import (
    MATERIAL_COVERAGE_EXCLUSIONS,
    MATERIAL_COVERAGE_SPECS,
    MaterialCoverageCounts,
)
from app.main import app
from app.services.material_coverage_service import MaterialCoverageService
from tests.admin_auth import AUTH_HEADERS

client = TestClient(app)


@pytest.fixture
def override(override_dependency):
    """経路の依存（`get_material_coverage_service`）を、テストが置いた値へ差し替える。"""

    def _set(dependency, value):
        override_dependency(dependency, lambda: value)

    return _set


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
