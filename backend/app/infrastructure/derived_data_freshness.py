"""派生データの鮮度を測る読み取り専用リポジトリ。

作り直しの記録（`derived_data_meta.py: read_records`。記録の鍵の種類はこの読み手が持つ）の鍵ごとに、記録と今の値を比べる。

- **ソース**: ソースごとに、今の派生の表を作った取込（`derived_source_runs`）が、そのソースの成功した
  最新の取込と同じか。違えば、生データを取り直したのに派生を作り直していない。取込が1度も成功して
  いないソースと、まだ作り直しに使っていないソースも、作り直し（か取込）が要る側に数える。
- **表**: 表ごとに、今の表を作ったときの列（`derived_columns`）が、今の宣言の列と同じか。違えば、最後の
  作り直しの後に列を足した・消した（足した列は全行がNULLのまま）。記録が無い表も作り直しが要る側に数える。

値のNULLは作り直しが要るかに使わない——作り直しは表ごと入れ替えるので、作り直した表のNULLは「計算した結果、値が無い」
（区間に切れない道・標高の取れない区間・土地被覆のタイルが無い区間）しかなく、列を足したあとに作り直していない表は上の表の比べが拾う。
列ごとのNULLの件数は参考として返す。

**対象は宣言から導く**——表の印（`orm_base.py: DERIVED`）を持つ表が派生データで、その表の主キー
以外の列が値である。ソースは取込の記録と作り直しの記録にあるものを全部並べる。較正値は効き方の宣言から導く。
"""

from dataclasses import dataclass
from typing import cast

import asyncpg
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.strict_model import StrictModel
from app.domain.tuning import TUNING_PARAMETERS, TuningEffect
from app.infrastructure.derived_data_meta import read_records
from app.infrastructure.orm_base import DERIVED_KEY, declared_metadata
from app.infrastructure.source_models import LATEST_SUCCEEDED_RUNS_SQL, SourceRunRow
from app.infrastructure.tuning_overrides import load_tuning_values


def derived_tables() -> list:
    """表の印（`orm_base.py: DERIVED`）を持つ表（＝派生データ）。"""
    return [table for table in declared_metadata().sorted_tables
            if table.info.get(DERIVED_KEY)]


def declared_columns() -> dict[str, frozenset[str]]:
    """派生の表ごとの、今の宣言の列（表の名前 → 列の名前）。作り直しが記録し、台帳が記録と比べる。"""
    return {table.name: frozenset(column.name for column in table.columns) for table in derived_tables()}


def value_columns(table) -> list[str]:
    """その表の「値」の列。鍵を除いたもの。"""
    keys = {column.name for column in table.primary_key.columns}
    return [column.name for column in table.columns if column.name not in keys]


class ColumnNulls(StrictModel, frozen=True):
    """値の列1本ぶんのNULLの件数。作り直しが要るかには使わない参考。"""

    column: str
    null_count: int


class ColumnsChange(StrictModel, frozen=True):
    """今の表を作ったときの列（記録）から、今の宣言の列への変化。"""

    #: 今の宣言にあって、今の表を作ったときに無かった列（全行がNULLのまま）。
    added: tuple[str, ...]
    #: 今の表を作ったときにあって、今の宣言に無い列。
    removed: tuple[str, ...]


class TableFreshness(StrictModel, frozen=True):
    table_name: str
    row_count: int
    columns: tuple[ColumnNulls, ...]
    #: 今の表を作ったときの列の記録が無ければ（列を記録する作り直しをまだしていない）None。
    columns_change: ColumnsChange | None


class SourceFreshness(StrictModel, frozen=True):
    source: str
    #: 今の派生の表を作った取込。まだ作り直しに使っていなければNone。
    derived_run_id: int | None
    #: そのソースの成功した最新の取込。1度も成功していなければNone。
    latest_run_id: int | None


class TuningFreshness(StrictModel, frozen=True):
    param_id: str
    #: 管理画面の表示名と単位（`domain/tuning.py: TuningParameter`の宣言）。
    label: str
    unit: str
    #: 今の派生を作った値。作り直しに使っていなければNone。
    derived_value: float | None
    #: 今の値（管理画面で変えた値）。
    current_value: float


@dataclass(frozen=True)
class DerivedDataFreshness:
    sources: tuple[SourceFreshness, ...]
    tables: tuple[TableFreshness, ...]
    tuning: tuple[TuningFreshness, ...]


def _build_table_sql(table) -> str:
    """1表ぶんの集計（行数・列ごとのNULLの件数）を1回の走査で求める。

    列名は宣言からのみ組み立てる（外部入力を連結しない）。
    """
    counts = [f"count(*) FILTER (WHERE {name} IS NULL) AS nulls_{name}" for name in value_columns(table)]
    return f"SELECT {', '.join(['count(*) AS row_count', *counts])} FROM {table.name}"  # 宣言のみ


class DerivedDataFreshnessQuery:
    """読み取り専用。全表走査を伴うため管理API専用。"""

    def __init__(self, session: AsyncSession):
        self._session = session

    async def get_freshness(self) -> DerivedDataFreshness:
        raw = (await (await self._session.connection()).get_raw_connection()).driver_connection
        records = await read_records(cast(asyncpg.Connection, raw))
        latest = {row.source: row.run_id for row in await self._session.execute(text(LATEST_SUCCEEDED_RUNS_SQL))}
        imported = set(await self._session.scalars(select(SourceRunRow.source).distinct()))
        sources = tuple(
            SourceFreshness(source=source, derived_run_id=records.runs.get(source), latest_run_id=latest.get(source))
            for source in sorted(imported | records.runs.keys()))
        current_tuning = await load_tuning_values(self._session)
        tuning = tuple(
            TuningFreshness(param_id=p.id, label=p.label, unit=p.unit, derived_value=records.tuning.get(p.id),
                            current_value=current_tuning[p.id])
            for p in TUNING_PARAMETERS if p.effect is TuningEffect.DERIVE_REBUILD)
        declared = declared_columns()
        tables: list[TableFreshness] = []
        for table in derived_tables():
            row = (await self._session.execute(text(_build_table_sql(table)))).mappings().one()
            built = records.columns.get(table.name)
            tables.append(TableFreshness(
                table_name=table.name,
                row_count=int(row["row_count"]),
                columns=tuple(ColumnNulls(column=name, null_count=int(row[f"nulls_{name}"]))
                              for name in value_columns(table)),
                columns_change=None if built is None else ColumnsChange(
                    added=tuple(sorted(declared[table.name] - built)),
                    removed=tuple(sorted(built - declared[table.name]))),
            ))
        return DerivedDataFreshness(sources=sources, tables=tuple(tables), tuning=tuning)
