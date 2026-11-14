"""費用の軸の定義の表（SQLAlchemy ORM）。

定義の全体（`domain/cost_axes.py: CostAxisDefinitions`）を1行のJSONBで持つ。全体を1回で読み、1回で書く（道の区分と同じ）ので、
行を軸ごとに分けない。形の検証は読むときに型（`StrictModel`の`extra="forbid"`）と`check_cost_axes`が行う——欄を消す・改名する
変更は、本番の行を先に直してからmasterへ入れる（`domain/strict_model.py`）。
"""

from sqlalchemy import Boolean, CheckConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.orm_base import Base


class CostAxisDefinitionsRow(Base):
    """費用の軸の定義の全体（行は1つだけ）。"""

    __tablename__ = "cost_axis_definitions"
    __table_args__ = (CheckConstraint("only_one", name="cost_axis_definitions_only_one_check"),)

    only_one: Mapped[bool] = mapped_column(Boolean, primary_key=True)
    definitions: Mapped[dict] = mapped_column(JSONB, nullable=False)
