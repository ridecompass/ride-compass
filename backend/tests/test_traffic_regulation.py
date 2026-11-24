"""交通規制1件が、いつ・誰に効くかの判断（`domain/traffic_regulation.py`）。

ここで見ないもの:
- 配布のコードを条件の組の値へ読み替えること → `test_source_models.py`
- 規制を区間へ当てること → `test_derive_traffic_regulations.py`
"""

from datetime import datetime

import numpy as np
import pytest

from app.domain.time_zone import JST
from app.domain.traffic_regulation import OTHER_DAYS, RegulationSlot, active_between, active_kinds

#: 8:00〜20:00に効く、自転車も対象の組。
DAYTIME = RegulationSlot(True, hours_from=8 * 60, hours_to=20 * 60)


def at(month: int, day: int, hour: int, minute: int = 0) -> datetime:
    """2026年の日本の時刻。11月22日は日曜、23日は月曜の休日（勤労感謝の日）、24日は火曜。"""
    return datetime(2026, month, day, hour, minute, tzinfo=JST)


@pytest.mark.parametrize(("slot", "invariant"), [
    (RegulationSlot(True), True),
    (RegulationSlot(True, hours_from=0, hours_to=24 * 60), True),
    # 曜日が「その他」は毎日、除外の曜日が「その他」は除外が無い。
    (RegulationSlot(True, days=OTHER_DAYS), True),
    (RegulationSlot(True, except_hours_from=12 * 60, except_hours_to=13 * 60, except_days=OTHER_DAYS), True),
    (DAYTIME, False),
    # 終日でも、曜日・期間の付いた組は時刻で変わる。
    (RegulationSlot(True, hours_from=0, hours_to=24 * 60, days=5), False),
    (RegulationSlot(True, period_from=719, period_to=831), False),
])
def test_only_a_slot_without_any_time_condition_is_time_invariant(slot, invariant):
    assert slot.time_invariant is invariant


@pytest.mark.parametrize(("slot", "start", "end", "active"), [
    (DAYTIME, at(11, 24, 7), at(11, 24, 7, 59), False),
    # 時間帯の端に触れれば効く（厳しい側）。
    (DAYTIME, at(11, 24, 7, 30), at(11, 24, 8), True),
    (DAYTIME, at(11, 24, 20), at(11, 24, 21), False),
    # 日をまたぐ時間の曜日は始まる日で決める: 日曜の22:00〜6:00は、月曜の3:00に効き、月曜の23:00には効かない。
    (RegulationSlot(True, hours_from=22 * 60, hours_to=6 * 60, days=5), at(11, 23, 3), at(11, 23, 3), True),
    (RegulationSlot(True, hours_from=22 * 60, hours_to=6 * 60, days=5), at(11, 23, 23), at(11, 23, 23), False),
    # 「日曜・休日」は、月曜の休日に効き、火曜には効かない。
    (RegulationSlot(True, days=3), at(11, 23, 12), at(11, 23, 12), True),
    (RegulationSlot(True, days=3), at(11, 24, 12), at(11, 24, 12), False),
    # 期間は毎年くり返し、年をまたぐこともある。
    (RegulationSlot(True, period_from=719, period_to=831), at(8, 1, 12), at(8, 1, 12), True),
    (RegulationSlot(True, period_from=719, period_to=831), at(9, 1, 12), at(9, 1, 12), False),
    (RegulationSlot(True, period_from=1201, period_to=228), at(1, 15, 12), at(1, 15, 12), True),
    # 除外の時間だけに収まる間は効かず、はみ出せば効く。
    (RegulationSlot(True, hours_from=8 * 60, hours_to=20 * 60, except_hours_from=12 * 60, except_hours_to=13 * 60),
     at(11, 24, 12, 10), at(11, 24, 12, 50), False),
    (RegulationSlot(True, hours_from=8 * 60, hours_to=20 * 60, except_hours_from=12 * 60, except_hours_to=13 * 60),
     at(11, 24, 11, 50), at(11, 24, 12, 10), True),
])
def test_a_slot_is_active_when_it_applies_anywhere_in_the_interval(slot, start, end, active):
    assert active_between(slot, start, end) is active


def test_the_kinds_of_regulations_active_on_each_edge():
    """規制0は自転車も対象の組と自転車は除外の組を持ち、規制1は組を持たない（いつでも全部の車両に効く）。区間0は規制0、区間1は
    規制1、区間2は規制が無い。効いている組だけが種類を決める。"""
    slots = np.array([DAYTIME.as_values(), RegulationSlot(False, hours_from=8 * 60, hours_to=20 * 60).as_values()],
                     dtype=np.int16)
    arrays = (np.array([0, 1, 2]), np.array([1, 1, 0]), np.array([0, 1]), np.array([0, 2]), np.array([2, 0]), slots)

    def kinds(slot_active):
        bicycle, excepted = active_kinds(np.arange(3), *arrays, np.array(slot_active), slotless_active=True)
        return list(zip(bicycle.tolist(), excepted.tolist(), strict=True))

    assert kinds([False, False]) == [(False, False), (True, False), (False, False)]
    assert kinds([False, True]) == [(False, True), (True, False), (False, False)]
    assert kinds([True, True]) == [(True, True), (True, False), (False, False)]
