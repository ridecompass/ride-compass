"""派生データの世代（1行のみ、id=1固定）と、今の派生の表を作った取込（`derived_source_runs`）・列（`derived_columns`）・
較正値（`derived_tuning`）。

世代は、派生の作り直しが作り直した表を入れ替えるたびに進める単調カウンタで、読み手は中身が作り直されたかをこの値で
見分ける。生データの世代と一緒に読める（`get_revisions`）。

**作り直しに使った取込の記録（`derived_source_runs`）では代用できない。** 同じ取込runのままバッチをもう一度
回す（バッチ側のバグ修正後の再実行、`derive_cli.py`の再実行）と値は変わりうるのに、
記録は変わらないためである。「中身を書き直した」という事実を
表せるのは書いた側が進めるカウンタだけである。

行は最初に世代を進めたとき（`bump_revision`）に作られる。行が無い間は`get_revisions()`の
派生の世代がNoneになる。
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass

import asyncpg
from sqlalchemy import BigInteger, CheckConstraint, Double, ForeignKey, Integer, String, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.orm_base import Base
from app.infrastructure.source_models import succeeded_run_count


class DerivedDataMetaRow(Base):
    __tablename__ = "derived_data_meta"
    __table_args__ = (CheckConstraint("id = 1", name="derived_data_meta_single_row"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)


class DerivedSourceRunRow(Base):
    """今の`public`の派生の表を作った取込。ソースごとに1行。

    そのソースを読む段が全部流れたら作り直しを始めた時点の成功した最新の取込を、そうでなければ前回の記録を書く
    （鮮度台帳がソースごとに比べる）。作り直す派生の表と一緒に作業用のスキーマで書き、表ごと入れ替える（`derive_cli.py`）——
    事故密度の分母がこの記録の事故の取込の年から読まれる（`road_graph_repository.py: get_accident_years`）ので、
    入れ替えの前に作業用のスキーマから作る道路網の配列も、入れ替えの後の読み手も、数と同じ取込の年を読む。段が読んだ
    生データがこの記録と一致するのは、取込と作り直しが同時に走らないためである。
    """

    __tablename__ = "derived_source_runs"

    source: Mapped[str] = mapped_column(String, primary_key=True)
    run_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("source_runs.run_id"), nullable=False)


class DerivedColumnRow(Base):
    """今の`public`の派生の表を作ったときの、表ごとの列（ORMの宣言）。表と列ごとに1行。

    流した段の表は今の宣言の列を、流さなかった段の表は前回の記録を書く。鮮度台帳（`derived_data_freshness.py`）がこの記録と
    今の宣言を比べ、最後に作り直した後に列を足した・消した表（足した列は全行がNULLのまま）を作り直しが要る側に数える。
    `derived_source_runs`と同じく作業用のスキーマで書き、表ごと入れ替える。
    """

    __tablename__ = "derived_columns"

    table_name: Mapped[str] = mapped_column(String, primary_key=True)
    column_name: Mapped[str] = mapped_column(String, primary_key=True)


class DerivedTuningRow(Base):
    """今の`public`の派生の表と道路網の配列を作ったときの較正値（`derive_cli.py`が段と配列へ渡した値）。較正値ごとに1行。

    派生の外で同じ値を読む所（地図の点のタイル・近くの点の読み出し・道路網の配列を作る読み出し）は、管理画面の今の上書きでは
    なくこの値を読む——上書きを変えてから作り直すまでの間も、派生の表と同じ値で読む。`derived_source_runs`と同じく
    作業用のスキーマで書き、表ごと入れ替えるので、派生の世代と一緒に変わる。
    """

    __tablename__ = "derived_tuning"

    param_id: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[float] = mapped_column(Double, nullable=False)


#: 派生の表と一緒に作業用のスキーマで書き、表ごと入れ替える作り直しの記録の表。
RECORD_TABLES: tuple[str, ...] = (DerivedSourceRunRow.__tablename__, DerivedColumnRow.__tablename__,
                                  DerivedTuningRow.__tablename__)


def recorded_tuning_sql(param_id: str) -> str:
    """作り直しに使った較正値を読むSQLの式（派生の表と記録は同じ作り直しで一緒に入れ替わる）。"""
    return f"(SELECT value FROM {DerivedTuningRow.__tablename__} WHERE param_id = '{param_id}')"


@dataclass(frozen=True)
class DataRevisions:
    """派生データの世代と生データの世代。"""

    #: 派生データの世代。行がまだ無ければNone。
    derived: int | None
    #: 生データの世代（`source_models.py: succeeded_run_count`）。取込だけを流したときは
    #: 派生の世代が動かないため、別に持つ。
    imported: int


async def get_revisions(session: AsyncSession) -> DataRevisions:
    """派生データの世代と生データの世代を1回の問い合わせで読む。"""
    derived = select(DerivedDataMetaRow.revision).scalar_subquery()
    row = (await session.execute(select(derived, succeeded_run_count()))).one()
    return DataRevisions(derived=row[0], imported=row[1])


async def bump_revision(conn: asyncpg.Connection) -> int:
    """世代を1つ進めて新しい値を返す。行が無ければ作って1にする。

    派生の表を入れ替えるトランザクションの中で呼ぶ——入れ替えと世代が別々にコミットされると、
    その間の読み手は新しい表を古い世代の鍵でキャッシュする。
    """
    revision: int = await conn.fetchval(
        "INSERT INTO derived_data_meta (id, revision) VALUES (1, 1)"
        " ON CONFLICT (id) DO UPDATE SET revision = derived_data_meta.revision + 1"
        " RETURNING revision")
    return revision


async def replace_source_runs(conn: asyncpg.Connection, runs: dict[str, int]) -> None:
    """派生の表を作った取込を`runs`へ置き換える。"""
    await _replace_rows(conn, DerivedSourceRunRow.__tablename__, ("source", "run_id"), runs.items())


async def replace_columns(conn: asyncpg.Connection, columns: Mapping[str, frozenset[str]]) -> None:
    """派生の表を作ったときの列を`columns`へ置き換える。"""
    await _replace_rows(
        conn, DerivedColumnRow.__tablename__, ("table_name", "column_name"),
        [(table, name) for table, names in columns.items() for name in sorted(names)])


@dataclass(frozen=True)
class DeriveRecords:
    """今の`public`の派生の表を作ったときの記録（作った取込・表ごとの列・使った較正値）。"""

    runs: dict[str, int]
    columns: dict[str, frozenset[str]]
    tuning: dict[str, float]


async def read_records(conn: asyncpg.Connection) -> DeriveRecords:
    """今の`public`の作り直しの記録。段を選んだ作り直しが流さなかった段の分を残すために、鮮度台帳が記録と今の値を比べるために読む。"""
    runs = {row["source"]: row["run_id"] for row in await conn.fetch(
        f"SELECT source, run_id FROM public.{DerivedSourceRunRow.__tablename__}")}
    columns: dict[str, set[str]] = {}
    for row in await conn.fetch(f"SELECT table_name, column_name FROM public.{DerivedColumnRow.__tablename__}"):
        columns.setdefault(row["table_name"], set()).add(row["column_name"])
    tuning = {row["param_id"]: row["value"] for row in await conn.fetch(
        f"SELECT param_id, value FROM public.{DerivedTuningRow.__tablename__}")}
    return DeriveRecords(runs=runs, columns={table: frozenset(names) for table, names in columns.items()}, tuning=tuning)


async def replace_tuning(conn: asyncpg.Connection, values: Mapping[str, float]) -> None:
    """作り直しに使った較正値を`values`へ置き換える。"""
    await _replace_rows(conn, DerivedTuningRow.__tablename__, ("param_id", "value"), values.items())


async def _replace_rows(conn: asyncpg.Connection, table: str, columns: tuple[str, str], rows: Iterable) -> None:
    await conn.execute(f"DELETE FROM {table}")
    await conn.executemany(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ($1, $2)", rows)
