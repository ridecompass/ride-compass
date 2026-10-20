"""派生データの鮮度レポートを組み立てるサービス層。

集計の生値へ、画面がそのまま並べられる判定（作り直しが要るか）を足す。
レポートの型は`GET /api/admin/derived-data/freshness`の応答の型を兼ねる。
"""

import logging
from datetime import datetime, timezone

from app.domain.db_status import source_needs_rebuild, table_needs_rebuild
from app.domain.stopwatch import elapsed_ms, start_timer
from app.domain.strict_model import StrictModel
from app.infrastructure.debug_log import log_external_call
from app.infrastructure.derived_data_freshness import (
    DerivedDataFreshness,
    DerivedDataFreshnessQuery,
    SourceFreshness,
    TableFreshness,
)

logger = logging.getLogger("ridecompass.derived_data_freshness")


class SourceEntry(SourceFreshness):
    #: `domain/db_status.py: source_needs_rebuild`の判断。画面は理由を問わずこれでソースを「作り直しが必要」に数える。
    needs_rebuild: bool


class TableEntry(TableFreshness):
    #: `domain/db_status.py: table_needs_rebuild`の判断。画面は理由を問わずこれで表を「作り直しが必要」に数える。
    needs_rebuild: bool


class DerivedDataFreshnessReport(StrictModel):
    computed_at: datetime
    sources: list[SourceEntry]
    tables: list[TableEntry]


def build_freshness_report(
    freshness: DerivedDataFreshness, computed_at: datetime
) -> DerivedDataFreshnessReport:
    return DerivedDataFreshnessReport(
        computed_at=computed_at,
        sources=[
            SourceEntry(
                **dict(source),
                needs_rebuild=source_needs_rebuild(derived_run_id=source.derived_run_id, latest_run_id=source.latest_run_id),
            )
            for source in freshness.sources
        ],
        tables=[
            TableEntry(
                **dict(table),
                needs_rebuild=table_needs_rebuild(
                    recorded=table.columns_change is not None,
                    added=() if table.columns_change is None else table.columns_change.added,
                    removed=() if table.columns_change is None else table.columns_change.removed,
                ),
            )
            for table in freshness.tables
        ],
    )


class DerivedDataFreshnessService:
    def __init__(self, repository: DerivedDataFreshnessQuery):
        self._repository = repository

    async def get_freshness_report(self) -> DerivedDataFreshnessReport:
        """DB例外は呼び出し元（router）へそのまま伝播させる。管理者向けの診断APIのため、
        空のレポートへ倒して「鮮度不整合なし」に見せるより失敗を明示する方が安全。"""
        started = start_timer()
        with log_external_call("admin:derived-data-freshness") as fields:
            freshness = await self._repository.get_freshness()
            fields["tables"] = len(freshness.tables)
        report = build_freshness_report(freshness, datetime.now(timezone.utc))
        stale_sources = sum(1 for source in report.sources if source.needs_rebuild)
        stale_tables = sum(1 for table in report.tables if table.needs_rebuild)
        logger.info(
            "derived data freshness computed tables=%d stale_sources=%d stale_tables=%d elapsed_ms=%d",
            len(report.tables), stale_sources, stale_tables,
            elapsed_ms(started),
        )
        return report
