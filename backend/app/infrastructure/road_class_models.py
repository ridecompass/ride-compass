"""道の区分のPostGISスキーマ（SQLAlchemy ORM）。

区分・地図の線の層・転がり抵抗・除外の設定の正本はこの表で、コードは写しを持たない。**表の中で閉じる形は表の制約だけが守る**
（docs/architecture/design-principles.md 構造仕様15。コードの宣言と軸を名指す値は、書く側が確かめる）。外部キーは全部トランザクションの終わりまで遅らせ、全体を1回で
入れ替える書き込み（`infrastructure/road_class_repository.py: replace_road_class_rows`）を、入れ替えた後の形で確かめる。
改名は「新しい鍵＋前の鍵」でしかしないので、`ON UPDATE CASCADE`は置かない。
"""

from typing import Any, Literal, TypedDict

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, attribute_keyed_dict, mapped_column, relationship

from app.infrastructure.orm_base import Base

_KEY_PATTERN = "^[a-z][a-z0-9_]*$"


class _Deferral(TypedDict):
    deferrable: bool
    initially: Literal["DEFERRED", "IMMEDIATE"]


_DEFERRED: _Deferral = {"deferrable": True, "initially": "DEFERRED"}
_IMMEDIATE: _Deferral = {"deferrable": True, "initially": "IMMEDIATE"}


def _classification_fk(ondelete: str | None = None) -> ForeignKey:
    return ForeignKey("road_classifications.classification_key", ondelete=ondelete, **_DEFERRED)


def _children(key: str | None, order_by: str) -> Any:
    """親を読むと一緒に読み、親と一緒に書く子の行。`key`の欄で引く辞書か、Noneなら並び。"""
    collection = list if key is None else attribute_keyed_dict(key)
    return relationship(lazy="selectin", cascade="all, delete-orphan", order_by=order_by, collection_class=collection)


def _class_fk(ondelete: str | None = None) -> ForeignKeyConstraint:
    return ForeignKeyConstraint(
        ["classification_key", "class_key"],
        ["road_classes.classification_key", "road_classes.class_key"],
        ondelete=ondelete,
        **_DEFERRED,
    )


class RoadClassificationRow(Base):
    """道の分け方1つ。"""

    __tablename__ = "road_classifications"
    __table_args__ = (
        CheckConstraint(f"classification_key ~ '{_KEY_PATTERN}'", name="road_classifications_classification_key_check"),
    )

    classification_key: Mapped[str] = mapped_column(String, primary_key=True)
    label: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(String, nullable=False)
    is_published: Mapped[bool] = mapped_column(Boolean, nullable=False)
    classes: Mapped[dict[str, "RoadClassRow"]] = _children("class_key", "RoadClassRow.class_key")


class RoadClassRow(Base):
    """分け方の区分1つ。"""

    __tablename__ = "road_classes"
    __table_args__ = (
        CheckConstraint(f"class_key ~ '{_KEY_PATTERN}'", name="road_classes_class_key_check"),
        UniqueConstraint("classification_key", "sort_order", name="road_classes_classification_key_sort_order_key", **_IMMEDIATE),
    )

    classification_key: Mapped[str] = mapped_column(String, _classification_fk(ondelete="CASCADE"), primary_key=True)
    class_key: Mapped[str] = mapped_column(String, primary_key=True)
    label: Mapped[str] = mapped_column(String, nullable=False)
    #: 意味の文だけ。
    description: Mapped[str] = mapped_column(String, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    former_keys: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False)
    condition_rows: Mapped[list["RoadClassConditionRow"]] = _children(None, "RoadClassConditionRow.condition_id")

    @property
    def conditions(self) -> list[dict[str, "RoadClassConditionTermRow"]]:
        return [condition.terms for condition in self.condition_rows]


class RoadClassConditionRow(Base):
    """区分の条件1つ。区分は、条件のどれかに当たる道。"""

    __tablename__ = "road_class_conditions"
    __table_args__ = (_class_fk(ondelete="CASCADE"),)

    condition_id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    classification_key: Mapped[str] = mapped_column(String, nullable=False)
    class_key: Mapped[str] = mapped_column(String, nullable=False)
    terms: Mapped[dict[str, "RoadClassConditionTermRow"]] = _children("fact_key", "RoadClassConditionTermRow.fact_key")


class RoadClassConditionTermRow(Base):
    """条件の項1つ。条件は、項が全部当たる道。"""

    __tablename__ = "road_class_condition_terms"
    __table_args__ = (
        CheckConstraint("array_position(fact_values, NULL) IS NULL", name="road_class_condition_terms_fact_values_check"),
        CheckConstraint(
            "cardinality(fact_values) > 0 OR negated <> matches_absent", name="road_class_condition_terms_check"
        ),
    )

    condition_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("road_class_conditions.condition_id", ondelete="CASCADE", **_DEFERRED), primary_key=True
    )
    #: 事実の材料のid（`domain/material_catalog.py: MATERIAL_CATALOG`の鍵）。
    fact_key: Mapped[str] = mapped_column(String, primary_key=True)
    fact_values: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False)
    # 2つの真偽は既定を置かない——書き忘れた道が黙って区分の外へ落ちないように。
    negated: Mapped[bool] = mapped_column(Boolean, nullable=False)
    matches_absent: Mapped[bool] = mapped_column(Boolean, nullable=False)


class RoadMapLayerRow(Base):
    """地図の線の層1つ（分け方を1つ指す）。"""

    __tablename__ = "road_map_layers"
    __table_args__ = (
        CheckConstraint("palette IN ('ordered', 'nominal')", name="road_map_layers_palette_check"),
        CheckConstraint("hue_slot BETWEEN 0 AND 11", name="road_map_layers_hue_slot_check"),
        CheckConstraint("(palette = 'nominal') = (hue_slot IS NOT NULL)", name="road_map_layers_check"),
        UniqueConstraint("group_key", "sort_order", name="road_map_layers_group_key_sort_order_key", **_IMMEDIATE),
        UniqueConstraint("hue_slot", name="road_map_layers_hue_slot_key", **_IMMEDIATE),
    )

    classification_key: Mapped[str] = mapped_column(String, _classification_fk(), primary_key=True)
    #: 地図の一覧の群（`domain/map_display.py: MAP_LAYER_CATEGORIES`の`key`）。
    group_key: Mapped[str] = mapped_column(String, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    #: アイコンの絵の鍵。絵は画面が持ち、知らない鍵には既定の絵を出す。
    icon_key: Mapped[str] = mapped_column(String, nullable=False)
    #: 一覧の説明。区分から組む部分は配るときに足す。
    summary: Mapped[str] = mapped_column(String, nullable=False)
    panel_hint: Mapped[str] = mapped_column(String, nullable=False)
    palette: Mapped[str] = mapped_column(String, nullable=False)
    hue_slot: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tone: Mapped[str | None] = mapped_column(String, nullable=True)
    #: この事実が無く区分の外の道を「データなし」とする。NULLなら区分の外は「該当なし」。
    no_data_fact_key: Mapped[str | None] = mapped_column(String, nullable=True)
    hides_unclassified: Mapped[bool] = mapped_column(Boolean, nullable=False)


class RoadRollingResistanceRow(Base):
    """走行モデルが転がり抵抗に読む分け方（行は1つだけ）。"""

    __tablename__ = "road_rolling_resistance"
    __table_args__ = (CheckConstraint("only_one", name="road_rolling_resistance_only_one_check"),)

    only_one: Mapped[bool] = mapped_column(Boolean, primary_key=True, server_default="true")
    classification_key: Mapped[str] = mapped_column(String, _classification_fk(), nullable=False)


class RoadRollingResistanceClassRow(Base):
    """区分ごとの転がり抵抗の較正値のid（`domain/tuning.py: TUNING_PARAMETERS`の`id`）。"""

    __tablename__ = "road_rolling_resistance_classes"
    __table_args__ = (_class_fk(),)

    classification_key: Mapped[str] = mapped_column(String, primary_key=True)
    class_key: Mapped[str] = mapped_column(String, primary_key=True)
    tuning_id: Mapped[str] = mapped_column(String, nullable=False)


class RoadAvoidanceClassificationRow(Base):
    """除外タブに出す分け方（地図の線の層の分け方だけ。凡例に無い見出しを作らない）。区分は全部「通る」で出る（違うものだけ
    `road_avoidance_overrides`が持つ）。"""

    __tablename__ = "road_avoidance_classifications"

    classification_key: Mapped[str] = mapped_column(
        String, ForeignKey("road_map_layers.classification_key", **_DEFERRED), primary_key=True
    )
    overrides: Mapped[dict[str, "RoadAvoidanceOverrideRow"]] = _children("class_key", "RoadAvoidanceOverrideRow.class_key")


class RoadAvoidanceOverrideRow(Base):
    """既定（「通る」で選べる）と違う区分1つ。"""

    __tablename__ = "road_avoidance_overrides"
    __table_args__ = (
        _class_fk(),
        CheckConstraint("default_level IN ('avoid', 'exclude')", name="road_avoidance_overrides_default_level_check"),
        CheckConstraint("selectable <> (default_level IS NULL)", name="road_avoidance_overrides_check"),
    )

    classification_key: Mapped[str] = mapped_column(
        String,
        ForeignKey("road_avoidance_classifications.classification_key", ondelete="CASCADE", **_DEFERRED),
        primary_key=True,
    )
    class_key: Mapped[str] = mapped_column(String, primary_key=True)
    #: NULLは「通る」。
    default_level: Mapped[str | None] = mapped_column(String, nullable=True)
    #: falseは除外タブに出さず、段も効かせない。
    selectable: Mapped[bool] = mapped_column(Boolean, nullable=False)
