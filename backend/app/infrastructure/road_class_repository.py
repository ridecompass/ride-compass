"""道の区分の表の、全体の読みと全体の入れ替え。

親子の行は表の宣言の関係（`infrastructure/road_class_models.py`）が一緒に読み書きし、行は全体の型へそのまま読み込む。
書く関数はcommitしない（取引の区切りは`services/road_class_service.py`が持つ）。入れ替えは全部の行を消してから入れ直し、
遅らせた外部キーと一意の制約は取引の終わり（commit）で確かめられる。
"""

from collections import defaultdict
from typing import Any

from pydantic import BaseModel
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.road_classes import RoadClassDefinitions
from app.infrastructure.road_class_models import (
    RoadAvoidanceClassificationRow,
    RoadAvoidanceOverrideRow,
    RoadAvoidanceSectionRow,
    RoadClassConditionRow,
    RoadClassConditionTermRow,
    RoadClassificationRow,
    RoadClassRow,
    RoadMapLayerRow,
    RoadRollingResistanceClassRow,
    RoadRollingResistanceRow,
)

# 2つの入れ替えが重なると、後の取引が前の取引の入れた行を消せずに主キーで断られる。表ごとの読みの間に入れ替えが確定すると、
# 前と後の全体が混ざる。プロセスをまたいで効くよう、取引の間だけのadvisory lockで、書きは排他、読みは共有で取る。
# 値はほかのadvisory lockと重ならなければよい。
_WRITE_LOCK_KEY = 0x524F4144434C5353


async def _keyed[T](session: AsyncSession, row_type: type[T], key: str) -> dict[str, T]:
    rows = (await session.scalars(select(row_type).order_by(text(key)))).all()
    return {getattr(row, key): row for row in rows}


async def read_road_classes(session: AsyncSession) -> RoadClassDefinitions:
    """表の全部の行を全体の型へ読み込む。辞書は鍵の順に並ぶ。"""
    await session.execute(text("SELECT pg_advisory_xact_lock_shared(:key)"), {"key": _WRITE_LOCK_KEY})
    rolling = await _keyed(session, RoadRollingResistanceRow, "classification_key")
    rolling_classes: dict[str, dict[str, str]] = defaultdict(dict)
    for row in await session.scalars(select(RoadRollingResistanceClassRow).order_by(text("classification_key, class_key"))):
        rolling_classes[row.classification_key][row.class_key] = row.tuning_id
    return RoadClassDefinitions.model_validate(
        {
            "classifications": await _keyed(session, RoadClassificationRow, "classification_key"),
            "map_layers": await _keyed(session, RoadMapLayerRow, "classification_key"),
            "rolling_resistance_classification": next(iter(rolling), None),
            "rolling_resistance_classes": rolling_classes,
            "avoidance_sections": await _keyed(session, RoadAvoidanceSectionRow, "section_key"),
            "avoidance_classifications": await _keyed(session, RoadAvoidanceClassificationRow, "classification_key"),
        },
        from_attributes=True,
    )


def _row[T](row_type: type[T], model: BaseModel, exclude: tuple[str, ...] = (), **fields: Any) -> T:
    """型の欄（`exclude`と、`fields`で渡す鍵・子の欄を除く）と`fields`から、表の行を作る。"""
    return row_type(**model.model_dump(exclude={*exclude, *fields}), **fields)


async def replace_road_class_rows(session: AsyncSession, definitions: RoadClassDefinitions) -> None:
    """表の全部の行を、`definitions`の行へ入れ替える。"""
    await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _WRITE_LOCK_KEY})
    for row_type in (
        RoadClassConditionTermRow, RoadClassConditionRow, RoadRollingResistanceClassRow, RoadRollingResistanceRow,
        RoadAvoidanceOverrideRow, RoadAvoidanceClassificationRow, RoadAvoidanceSectionRow, RoadMapLayerRow,
        RoadClassRow, RoadClassificationRow,
    ):
        await session.execute(delete(row_type))
    session.add_all([
        _row(RoadClassificationRow, c, classification_key=key, classes={
            class_key: _row(RoadClassRow, r, ("conditions",), class_key=class_key, condition_rows=[
                RoadClassConditionRow(terms={
                    fact_key: _row(RoadClassConditionTermRow, term, fact_key=fact_key) for fact_key, term in condition.items()
                })
                for condition in r.conditions
            ])
            for class_key, r in c.classes.items()
        })
        for key, c in definitions.classifications.items()
    ])
    session.add_all(_row(RoadMapLayerRow, layer, classification_key=key) for key, layer in definitions.map_layers.items())
    if definitions.rolling_resistance_classification is not None:
        session.add(RoadRollingResistanceRow(classification_key=definitions.rolling_resistance_classification))
    session.add_all(
        RoadRollingResistanceClassRow(classification_key=key, class_key=class_key, tuning_id=tuning_id)
        for key, by_class in definitions.rolling_resistance_classes.items() for class_key, tuning_id in by_class.items()
    )
    session.add_all(_row(RoadAvoidanceSectionRow, s, section_key=key) for key, s in definitions.avoidance_sections.items())
    session.add_all(
        _row(RoadAvoidanceClassificationRow, a, classification_key=key, overrides={
            class_key: _row(RoadAvoidanceOverrideRow, o, class_key=class_key) for class_key, o in a.overrides.items()
        })
        for key, a in definitions.avoidance_classifications.items()
    )
    await session.flush()
