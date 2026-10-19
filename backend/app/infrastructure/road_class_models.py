"""道の区分の群と行のPostGISスキーマ（SQLAlchemy ORM）。

群と行（`domain/road_classes.py: RoadClassGroup`）の正本はこの表で、コードは写しを持たない。
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.orm_base import Base


class RoadClassGroupRow(Base):
    """1つの群。sort_orderが地図の層の並び。

    並びの一意は遅らせられる（並べ替えるトランザクションで`SET CONSTRAINTS ... DEFERRED`にすれば、入れ替えの途中で断られない）。
    行の並びも同じ。
    """

    __tablename__ = "road_class_groups"
    __table_args__ = (
        UniqueConstraint("sort_order", name="road_class_groups_sort_order_key", deferrable=True, initially="IMMEDIATE"),
    )

    group_key: Mapped[str] = mapped_column(String, primary_key=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    label: Mapped[str] = mapped_column(String, nullable=False)
    palette: Mapped[str] = mapped_column(String, nullable=False)
    hue_slot: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tone: Mapped[str | None] = mapped_column(String, nullable=True)
    is_published: Mapped[bool] = mapped_column(Boolean, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class RoadClassRowRow(Base):
    """群の中の1つの行。sort_orderが群の中の判定の順。matchは`domain/road_classes.py: RoadClassRow.match`の
    `model_dump(mode="json")`そのもの。"""

    __tablename__ = "road_class_rows"
    __table_args__ = (
        UniqueConstraint(
            "group_key", "sort_order", name="road_class_rows_group_key_sort_order_key",
            deferrable=True, initially="IMMEDIATE"),
    )

    group_key: Mapped[str] = mapped_column(
        String, ForeignKey("road_class_groups.group_key", ondelete="CASCADE"), primary_key=True)
    row_key: Mapped[str] = mapped_column(String, primary_key=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    label: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(String, nullable=False)
    default_level: Mapped[str] = mapped_column(String, nullable=False)
    always_excluded: Mapped[bool] = mapped_column(Boolean, nullable=False)
    former_keys: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, server_default=text("'{}'"))
    match: Mapped[list] = mapped_column(JSONB, nullable=False)
