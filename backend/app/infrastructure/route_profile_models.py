"""ひな形の表（SQLAlchemy ORM）。

ひな形の全体（`domain/route_profiles.py: RouteProfiles`）を1行のJSONBで持つ。全体を1回で読み、1回で書く（費用の軸の定義と
同じ形）。ひな形が名指す費用の軸と道の段の行は表の外の正本にあり外部キーを張れないので、名指す先の確かめは書く側が持つ
（`services/route_profile_service.py`）。
"""

from sqlalchemy import Boolean, CheckConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.orm_base import Base


class RouteProfilesRow(Base):
    """ひな形の全体（行は1つだけ）。"""

    __tablename__ = "route_profiles"
    __table_args__ = (CheckConstraint("only_one", name="route_profiles_only_one_check"),)

    only_one: Mapped[bool] = mapped_column(Boolean, primary_key=True)
    profiles: Mapped[dict] = mapped_column(JSONB, nullable=False)
