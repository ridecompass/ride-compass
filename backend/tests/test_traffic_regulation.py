"""交通規制1件が、いつ・誰に効くかの判断（`domain/traffic_regulation.py`）。

コードの値は配布元の説明書（拡張版標準フォーマット k_2.1）の共通コード表から取る。

ここで見ないもの:
- 規制を区間へ当てること → `test_derive_traffic_regulations.py`
"""

from dataclasses import replace

import pytest

from app.domain.traffic_regulation import ALL_DAY, TIMED, RegulationSlot, applies_to_bicycles, regulation_hours

_NO_VEHICLES = ("", "", "", "")
EMPTY = RegulationSlot(hours_from="", hours_to="", days="", period_from="", period_to="", vehicles=_NO_VEHICLES,
                       except_hours_from="", except_hours_to="", except_days="", except_period_from="",
                       except_period_to="", except_vehicles=_NO_VEHICLES)


@pytest.mark.parametrize(("slots", "expected"), [
    ([EMPTY], ALL_DAY),
    ([replace(EMPTY, hours_from="0", hours_to="2400")], ALL_DAY),
    ([replace(EMPTY, hours_from="800", hours_to="2000")], TIMED),
    # 時間の組のどれかが終日なら、ほかの組の時間は終日を狭めない。
    ([replace(EMPTY, hours_from="800", hours_to="2000"), replace(EMPTY, hours_from="0", hours_to="2400")], ALL_DAY),
    # 曜日・期間・除外の時間は、時間が終日でも効く日・時刻を限る。
    ([replace(EMPTY, days="1")], TIMED),
    ([replace(EMPTY, hours_from="0", hours_to="2400", except_days="6")], TIMED),
    ([replace(EMPTY, period_from="0401", period_to="0930")], TIMED),
    ([replace(EMPTY, except_period_from="1229", except_period_to="0103")], TIMED),
    ([replace(EMPTY, except_hours_from="1200", except_hours_to="1300")], TIMED),
])
def test_regulation_hours(slots, expected):
    assert regulation_hours(slots) == expected


def _vehicles(a: str = "", d: str = "") -> tuple[str, str, str, str]:
    return (a, "", "", d)


@pytest.mark.parametrize(("slots", "expected"), [
    # 対象の車両がどの組にも無ければ、車両の全部が対象。
    ([EMPTY], True),
    ([replace(EMPTY, except_vehicles=_vehicles(d="100"))], False),
    # 区分 A の車両は自転車を含み、自動車は含まない。
    ([replace(EMPTY, vehicles=_vehicles(a="1"))], True),
    ([replace(EMPTY, vehicles=_vehicles(a="10"))], False),
    # 区分 D の自転車・軽車両は自転車を含み、歩行者は含まない。コードは車種の位を足した数。
    ([replace(EMPTY, vehicles=_vehicles(d="100"))], True),
    ([replace(EMPTY, vehicles=_vehicles(d="1100000"))], True),
    ([replace(EMPTY, vehicles=_vehicles(d="1000000"))], False),
    # 除外は対になる対象の組にだけ効く。
    ([replace(EMPTY, vehicles=_vehicles(a="1"), except_vehicles=_vehicles(d="100000"))], False),
    ([replace(EMPTY, vehicles=_vehicles(a="1")), replace(EMPTY, except_vehicles=_vehicles(d="100"))], True),
])
def test_applies_to_bicycles(slots, expected):
    assert applies_to_bicycles(slots) is expected
