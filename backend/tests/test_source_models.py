"""外部ソースの生データの読み替え（`infrastructure/source_models.py`）のうち、SQL の外で値へ戻すもの。

コードの値は配布元の説明書（JARTIC の拡張版標準フォーマット k_2.1）の共通コード表から取る。

ここで見ないもの:
- 読み替えた値で、規制がいつ・誰に効くかの判断 → `test_traffic_regulation.py`
- 生データを読む SQL の列 → 派生の段のテスト（`test_derive_traffic_regulations.py`等）
"""

import json

import pytest

from app.domain.traffic_regulation import RegulationSlot
from app.infrastructure.source_models import regulation_slots

_NO_VEHICLES = ["", "", "", ""]
_EMPTY = {"hours_from": "", "hours_to": "", "days": "", "period_from": "", "period_to": "", "vehicles": _NO_VEHICLES,
          "except_hours_from": "", "except_hours_to": "", "except_days": "", "except_period_from": "",
          "except_period_to": "", "except_vehicles": _NO_VEHICLES}


def _slot(**fields) -> RegulationSlot:
    return regulation_slots(json.dumps([{**_EMPTY, **fields}]))[0]


@pytest.mark.parametrize(("hours", "minutes"), [
    (("0", "2400"), (0, 24 * 60)),
    (("830", "1745"), (8 * 60 + 30, 17 * 60 + 45)),
    (("800", ""), (8 * 60, None)),
])
def test_regulation_hours_are_minutes_from_midnight(hours, minutes):
    slot = _slot(hours_from=hours[0], hours_to=hours[1])
    assert (slot.hours_from, slot.hours_to) == minutes


def _given(slot: RegulationSlot) -> tuple[bool, ...]:
    return slot.days, slot.period, slot.vehicles, slot.except_hours, slot.except_days, slot.except_period


def test_regulation_fields_are_whether_given():
    assert _given(_slot()) == (False,) * 6
    slot = _slot(days="1", period_to="0930", vehicles=_vehicles(a="10"), except_hours_from="1200", except_days="6",
                 except_period_from="1229")
    assert _given(slot) == (True,) * 6


def _vehicles(a: str = "", d: str = "") -> list[str]:
    return [a, "", "", d]


@pytest.mark.parametrize(("vehicles", "bicycle"), [
    # 区分 A の車両は自転車を含み、自動車は含まない。
    (_vehicles(a="1"), True),
    (_vehicles(a="10"), False),
    # 区分 D の自転車・軽車両は自転車を含み、歩行者は含まない。コードは車種の位を足した数。
    (_vehicles(d="100"), True),
    (_vehicles(d="1100000"), True),
    (_vehicles(d="1000000"), False),
])
def test_vehicle_codes_include_bicycles(vehicles, bicycle):
    slot = _slot(vehicles=vehicles, except_vehicles=vehicles)
    assert (slot.vehicles, slot.vehicles_bicycle, slot.except_vehicles_bicycle) == (True, bicycle, bicycle)
