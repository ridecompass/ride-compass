"""道の区分の表の、全体の読みと全体の入れ替え。

書く関数はcommitしない（取引の区切りは`services/road_class_service.py`が持つ）。入れ替えは全部の行を消してから入れ直し、
遅らせた外部キーと一意の制約は取引の終わり（commit）で確かめられる。
"""

from collections import defaultdict

from sqlalchemy import delete, insert, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.road_classes import (
    AvoidanceClassification,
    AvoidanceOverride,
    AvoidanceSection,
    ConditionTerm,
    RoadClass,
    RoadClassDefinitions,
    RoadClassification,
    RoadMapLayer,
)
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

# 2つの入れ替えが重なると、後の取引が前の取引の入れた行を消せずに主キーで断られる。プロセスをまたいで効くよう、
# 取引の間だけのadvisory lockで直列にする。値はほかのadvisory lockと重ならなければよい。
_WRITE_LOCK_KEY = 0x524F4144434C5353

_ROW_TYPES = (
    RoadClassificationRow,
    RoadClassRow,
    RoadClassConditionRow,
    RoadClassConditionTermRow,
    RoadMapLayerRow,
    RoadRollingResistanceRow,
    RoadRollingResistanceClassRow,
    RoadAvoidanceSectionRow,
    RoadAvoidanceClassificationRow,
    RoadAvoidanceOverrideRow,
)


async def _rows[T](session: AsyncSession, row_type: type[T], *order_by: object) -> list[T]:
    return list((await session.execute(select(row_type).order_by(*order_by))).scalars().all())


async def read_road_classes(session: AsyncSession) -> RoadClassDefinitions:
    """表の全部の行を全体の型へ写す。辞書は鍵の順に並ぶ。"""
    # 表ごとの読みの間に入れ替えが確定すると、前と後の全体が混ざる（項を読んだ後に条件が作り直されると、条件が項を失う）。
    # 入れ替えの取引と同じ鍵を共有で取り、読み終えるまで入れ替えを待たせる。
    await session.execute(text("SELECT pg_advisory_xact_lock_shared(:key)"), {"key": _WRITE_LOCK_KEY})
    terms: dict[int, dict[str, ConditionTerm]] = defaultdict(dict)
    for term in await _rows(session, RoadClassConditionTermRow, RoadClassConditionTermRow.condition_id, RoadClassConditionTermRow.fact_key):
        terms[term.condition_id][term.fact_key] = ConditionTerm(
            fact_values=term.fact_values, negated=term.negated, matches_absent=term.matches_absent
        )
    conditions: dict[tuple[str, str], list[dict[str, ConditionTerm]]] = defaultdict(list)
    for condition in await _rows(session, RoadClassConditionRow, RoadClassConditionRow.condition_id):
        conditions[condition.classification_key, condition.class_key].append(terms[condition.condition_id])
    classes: dict[str, dict[str, RoadClass]] = defaultdict(dict)
    for row in await _rows(session, RoadClassRow, RoadClassRow.classification_key, RoadClassRow.class_key):
        classes[row.classification_key][row.class_key] = RoadClass(
            label=row.label,
            description=row.description,
            sort_order=row.sort_order,
            former_keys=row.former_keys,
            conditions=conditions[row.classification_key, row.class_key],
        )
    rolling = await _rows(session, RoadRollingResistanceRow)
    rolling_classes: dict[str, dict[str, str]] = defaultdict(dict)
    for row in await _rows(
        session, RoadRollingResistanceClassRow, RoadRollingResistanceClassRow.classification_key, RoadRollingResistanceClassRow.class_key
    ):
        rolling_classes[row.classification_key][row.class_key] = row.tuning_id
    overrides: dict[str, dict[str, AvoidanceOverride]] = defaultdict(dict)
    for row in await _rows(session, RoadAvoidanceOverrideRow, RoadAvoidanceOverrideRow.classification_key, RoadAvoidanceOverrideRow.class_key):
        overrides[row.classification_key][row.class_key] = AvoidanceOverride(
            section_key=row.section_key, default_level=row.default_level, selectable=row.selectable
        )
    return RoadClassDefinitions(
        classifications={
            row.classification_key: RoadClassification(
                label=row.label,
                description=row.description,
                is_published=row.is_published,
                classes=classes[row.classification_key],
            )
            for row in await _rows(session, RoadClassificationRow, RoadClassificationRow.classification_key)
        },
        map_layers={
            row.classification_key: RoadMapLayer(
                group_key=row.group_key,
                sort_order=row.sort_order,
                icon_key=row.icon_key,
                summary=row.summary,
                panel_hint=row.panel_hint,
                palette=row.palette,
                hue_slot=row.hue_slot,
                tone=row.tone,
                no_data_fact_key=row.no_data_fact_key,
                hides_unclassified=row.hides_unclassified,
            )
            for row in await _rows(session, RoadMapLayerRow, RoadMapLayerRow.classification_key)
        },
        rolling_resistance_classification=rolling[0].classification_key if rolling else None,
        rolling_resistance_classes=dict(rolling_classes),
        avoidance_sections={
            row.section_key: AvoidanceSection(label=row.label, description=row.description, sort_order=row.sort_order)
            for row in await _rows(session, RoadAvoidanceSectionRow, RoadAvoidanceSectionRow.section_key)
        },
        avoidance_classifications={
            row.classification_key: AvoidanceClassification(
                section_key=row.section_key, sort_order=row.sort_order, overrides=overrides[row.classification_key]
            )
            for row in await _rows(session, RoadAvoidanceClassificationRow, RoadAvoidanceClassificationRow.classification_key)
        },
    )


async def acquire_write_lock(session: AsyncSession) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _WRITE_LOCK_KEY})


async def _insert(session: AsyncSession, row_type: type, values: list[dict[str, object]]) -> None:
    if values:
        await session.execute(insert(row_type), values)


async def replace_road_class_rows(session: AsyncSession, definitions: RoadClassDefinitions) -> None:
    """表の全部の行を、`definitions`の行へ入れ替える。"""
    for row_type in _ROW_TYPES:
        await session.execute(delete(row_type))
    classifications = definitions.classifications.items()
    await _insert(session, RoadClassificationRow, [
        {"classification_key": key, "label": c.label, "description": c.description, "is_published": c.is_published}
        for key, c in classifications
    ])
    await _insert(session, RoadClassRow, [
        {"classification_key": key, "class_key": class_key, "label": r.label, "description": r.description,
         "sort_order": r.sort_order, "former_keys": r.former_keys}
        for key, c in classifications for class_key, r in c.classes.items()
    ])
    owners = [(key, class_key, condition) for key, c in classifications for class_key, r in c.classes.items() for condition in r.conditions]
    if owners:
        condition_ids = (
            await session.execute(
                insert(RoadClassConditionRow).returning(RoadClassConditionRow.condition_id, sort_by_parameter_order=True),
                [{"classification_key": key, "class_key": class_key} for key, class_key, _ in owners],
            )
        ).scalars().all()
        await _insert(session, RoadClassConditionTermRow, [
            {"condition_id": condition_id, "fact_key": fact_key, **term.model_dump()}
            for condition_id, (_, _, condition) in zip(condition_ids, owners, strict=True)
            for fact_key, term in condition.items()
        ])
    await _insert(session, RoadMapLayerRow, [
        {"classification_key": key, **layer.model_dump()} for key, layer in definitions.map_layers.items()
    ])
    if definitions.rolling_resistance_classification is not None:
        await _insert(session, RoadRollingResistanceRow, [{"classification_key": definitions.rolling_resistance_classification}])
    await _insert(session, RoadRollingResistanceClassRow, [
        {"classification_key": key, "class_key": class_key, "tuning_id": tuning_id}
        for key, by_class in definitions.rolling_resistance_classes.items() for class_key, tuning_id in by_class.items()
    ])
    await _insert(session, RoadAvoidanceSectionRow, [
        {"section_key": key, **section.model_dump()} for key, section in definitions.avoidance_sections.items()
    ])
    await _insert(session, RoadAvoidanceClassificationRow, [
        {"classification_key": key, "section_key": a.section_key, "sort_order": a.sort_order}
        for key, a in definitions.avoidance_classifications.items()
    ])
    await _insert(session, RoadAvoidanceOverrideRow, [
        {"classification_key": key, "class_key": class_key, **override.model_dump()}
        for key, a in definitions.avoidance_classifications.items() for class_key, override in a.overrides.items()
    ])
