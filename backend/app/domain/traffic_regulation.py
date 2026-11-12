"""交通規制の1件が、いつ・誰に効くかの判断。

規制は条件の組をいくつか持ち、組ごとに対象の期間・時間・曜日・車両と、除外の期間・時間・曜日・車両を持つ（対象の i 番目と
除外の i 番目が対になる）。配布のコードの読み替えは`infrastructure/source_models.py: regulation_slots`が持ち、ここへは
読み替えた値で届く。
"""

from collections.abc import Iterable
from dataclasses import dataclass

#: 規制が効く時間帯の語彙。前ほど強い（長く効く）順に並べる。
ALL_DAY = "all_day"
TIMED = "timed"
REGULATION_HOURS: tuple[str, ...] = (ALL_DAY, TIMED)
REGULATION_HOURS_LABELS: dict[str, str] = {ALL_DAY: "終日", TIMED: "時間帯"}

#: 終日（0:00〜24:00）の規制時間。時刻は0:00からの分。
_WHOLE_DAY = (0, 24 * 60)


@dataclass(frozen=True)
class RegulationSlot:
    """規制の条件の組1つ。規制時間は0:00からの分で、欄が空なら None。`vehicles`は対象の車両の指定があるか、
    `*_bicycle`は対象・除外の車両が普通自転車を含むか、ほかは欄の指定があるか。"""

    hours_from: int | None
    hours_to: int | None
    days: bool
    period: bool
    vehicles: bool
    vehicles_bicycle: bool
    except_hours: bool
    except_days: bool
    except_period: bool
    except_vehicles_bicycle: bool


def regulation_hours(slots: Iterable[RegulationSlot]) -> str:
    """規制が終日効くか（`ALL_DAY`）、時間帯で効くか（`TIMED`）。

    終日は、規制時間が無いか、組のどれかが0:00〜24:00で、どの組にも曜日・期間・除外の時間の指定が無いとき。
    """
    slots = list(slots)
    hours = [(s.hours_from, s.hours_to) for s in slots if s.hours_from is not None or s.hours_to is not None]
    if hours and _WHOLE_DAY not in hours:
        return TIMED
    limited = any(s.days or s.period or s.except_hours or s.except_days or s.except_period for s in slots)
    return TIMED if limited else ALL_DAY


def applies_to_bicycles(slots: Iterable[RegulationSlot]) -> bool:
    """普通自転車も規制の対象か。組のどれかが、対象の車両に自転車を含み、対になる除外の車両に自転車を含まないとき。
    対象の車両がどの組にも無い規制は、車両の全部を対象とみなす。"""
    slots = list(slots)
    if not any(s.vehicles for s in slots):
        return not any(s.except_vehicles_bicycle for s in slots)
    return any(s.vehicles_bicycle and not s.except_vehicles_bicycle for s in slots)

