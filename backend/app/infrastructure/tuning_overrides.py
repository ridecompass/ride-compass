"""較正値の値（`app/domain/tuning.py`の宣言の全idの値。**値の正本はこの表だけ**で、コードは値を持たない）。

費用の軸の定義（`cost_axis_definitions`）と同じく「行そのものが値」の形で、宣言にあるidの行が無ければ読めない
（起動しない）。較正値を宣言に足すときは、デプロイの前に本番の表へ行を入れる（読むのは宣言にあるidの行だけなので、
先に入れても動きは変わらない）。宣言から消すときは、デプロイの後に行を消す。

読むのは値が取れるかだけ。管理画面から書く値は、書く前に宣言の範囲と値どうしの順の約束を確かめる（人が打った入力）。
プロセス内の`domain/tuning.py: TUNING_VALUES`へは書かない。
"""

from datetime import datetime

from sqlalchemy import DateTime, Float, String, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.domain.tuning import TUNING_PARAMETERS, TUNING_PARAMETERS_BY_ID, TUNING_VALUES, misordered_pairs
from app.infrastructure.orm_base import Base


class TuningOverrideError(RuntimeError):
    """管理画面から書く値が、宣言の範囲の外か、いまの値と重ねて値どうしの順の約束を破る。"""


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
        """宣言にある1件を書く。宣言の範囲の外（数でない値も）か、いまの値と重ねて値どうしの順の約束
        （`domain/tuning.py: TUNING_ORDERINGS`）を破れば、書かずに`TuningOverrideError`。"""
        parameter = TUNING_PARAMETERS_BY_ID[param_id]
        if not parameter.minimum <= value <= parameter.maximum:
            raise TuningOverrideError(f"較正値が宣言の範囲の外: {param_id}={value}（{parameter.minimum}〜{parameter.maximum}）")
        if misordered := misordered_pairs({**TUNING_VALUES, param_id: value}):
            raise TuningOverrideError(f"較正値の順の約束を破る（下側, 上側）: {misordered}")
        await self._session.execute(
            pg_insert(TuningOverrideRow)
            .values(param_id=param_id, value=value)
            .on_conflict_do_update(index_elements=["param_id"], set_={"value": value, "updated_at": func.now()})
        )
