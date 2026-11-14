"""交通規制1件が、いつ・誰に効くかの判断（`domain/traffic_regulation.py`）。

ここで見ないもの:
- 配布のコードを条件の組の値へ読み替えること → `test_source_models.py`
- 規制を区間へ当てること → `test_derive_traffic_regulations.py`
"""

from dataclasses import replace

import pytest

from app.domain.traffic_regulation import ALL_DAY, TIMED, RegulationSlot, applies_to_bicycles, regulation_hours

EMPTY = RegulationSlot(hours_from=None, hours_to=None, days=False, period=False, vehicles=False, vehicles_bicycle=False,
                       except_hours=False, except_days=False, except_period=False, except_vehicles_bicycle=False)


@pytest.mark.parametrize(("slots", "expected"), [
    ([EMPTY], ALL_DAY),
    ([replace(EMPTY, hours_from=0, hours_to=24 * 60)], ALL_DAY),
    ([replace(EMPTY, hours_from=8 * 60, hours_to=20 * 60)], TIMED),
    ([replace(EMPTY, hours_from=0)], TIMED),
    # 時間の組のどれかが終日なら、ほかの組の時間は終日を狭めない。
    ([replace(EMPTY, hours_from=8 * 60, hours_to=20 * 60), replace(EMPTY, hours_from=0, hours_to=24 * 60)], ALL_DAY),
    # 曜日・期間・除外の時間は、時間が終日でも効く日・時刻を限る。
    ([replace(EMPTY, days=True)], TIMED),
    ([replace(EMPTY, hours_from=0, hours_to=24 * 60, except_days=True)], TIMED),
    ([replace(EMPTY, period=True)], TIMED),
    ([replace(EMPTY, except_period=True)], TIMED),
    ([replace(EMPTY, except_hours=True)], TIMED),
])
def test_regulation_hours(slots, expected):
    assert regulation_hours(slots) == expected


_CAR = replace(EMPTY, vehicles=True)
_BICYCLE = replace(EMPTY, vehicles=True, vehicles_bicycle=True)


@pytest.mark.parametrize(("slots", "expected"), [
    # 対象の車両がどの組にも無ければ、車両の全部が対象。
    ([EMPTY], True),
    ([replace(EMPTY, except_vehicles_bicycle=True)], False),
    ([_BICYCLE], True),
    ([_CAR], False),
    # 除外は対になる対象の組にだけ効く。
    ([replace(_BICYCLE, except_vehicles_bicycle=True)], False),
    ([_BICYCLE, replace(EMPTY, except_vehicles_bicycle=True)], True),
])
def test_applies_to_bicycles(slots, expected):
    assert applies_to_bicycles(slots) is expected
