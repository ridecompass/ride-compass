"""較正値の値（`app/domain/tuning.py`の宣言の全idの値。**値の正本はこの表だけ**で、コードは値を持たない）。

費用の軸の定義（`cost_axis_definitions`）と同じく「行そのものが値」の形で、宣言にあるidの行が無ければ読めない
（起動しない）。較正値を宣言に足すときは、デプロイの前に本番の表へ行を入れる（読むのは宣言にあるidの行だけなので、
先に入れても動きは変わらない）。宣言から消すときは、デプロイの後に行を消す。

読むのは値が取れるかだけで、管理画面から書いた値はそのまま持つ。プロセス内の`domain/tuning.py: TUNING_VALUES`へは書かない。
"""

from datetime import datetime

from sqlalchemy import DateTime, Float, String, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.domain.tuning import TUNING_PARAMETERS
from app.infrastructure.orm_base import Base


class TuningOverrideRow(Base):
    __tablename__ = "tuning_overrides"

    param_id: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[float] = mapped_column(Float, nullable=False)
    #: いつこの値へ動かしたか。アプリのプロセスの時計ではなくDBの時計（`now()`）で揃える。
    #: 列の既定は挿入にしか効かないため、既存の行を書き換えるときは`set_value`が明示する。
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now())


async def load_tuning_values(session: AsyncSession) -> dict[str, float]:
    """DBの表から、宣言の全idの値を読む（行が無ければ`KeyError`。プロセスへは反映しない）。"""
    rows = await TuningOverrideStore(session).read_values()
    return {p.id: rows[p.id] for p in TUNING_PARAMETERS}


class TuningOverrideStore:
    """値の行の読み書き。取引の区切り（`commit`）は呼び出し元が持つ。"""

    def __init__(self, session: AsyncSession):
        self._session = session

    async def read_values(self) -> dict[str, float]:
        """テーブルの中身（id → 値）。"""
        rows = (await self._session.execute(select(TuningOverrideRow))).scalars().all()
        return {row.param_id: float(row.value) for row in rows}

    async def set_value(self, param_id: str, value: float) -> None:
        """1件を書く。"""
        await self._session.execute(
            pg_insert(TuningOverrideRow)
            .values(param_id=param_id, value=value)
            .on_conflict_do_update(index_elements=["param_id"], set_={"value": value, "updated_at": func.now()})
        )
