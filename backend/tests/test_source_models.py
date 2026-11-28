"""外部ソースの生データの読み替え（`infrastructure/source_models.py`）のうち、SQL の外で値へ戻すもの。

コードの値は配布元の説明書（JARTIC の拡張版標準フォーマット k_2.1）の共通コード表から取る。

ここで見ないもの:
- 読み替えた値で、規制がいつ・誰に効くかの判断 → `test_traffic_regulation.py`
- 生データを読む SQL の列 → 派生の段のテスト（`test_derive_traffic_regulations.py`等）
"""

import json

import pytest

from app.domain.traffic_regulation import OTHER_DAYS, RegulationSlot
from app.infrastructure.source_models import regulation_slots

_NO_VEHICLES = ["", "", "", ""]
_EMPTY = {"hours_from": "", "hours_to": "", "days": "", "period_from": "", "period_to": "", "vehicles": _NO_VEHICLES,
          "except_hours_from": "", "except_hours_to": "", "except_days": "", "except_period_from": "",
          "except_period_to": "", "except_vehicles": _NO_VEHICLES}


def _slots(**fields) -> list[RegulationSlot]:
    return regulation_slots(json.dumps([{**_EMPTY, **fields}]))


def _slot(**fields) -> RegulationSlot:
    [slot] = _slots(**fields)
    return slot


def test_regulation_hours_are_minutes_and_an_end_of_0_or_2400_is_the_end_of_the_day():
    """終わりの「0」「2400」を24:00と読めないと、終日の規制が効かない時間帯になる。"""
    assert (_slot(hours_from="0730", hours_to="2400").hours_from, _slot(hours_from="0", hours_to="2400").hours_to) == (
        7 * 60 + 30, 24 * 60)
    assert _slot(hours_from="2200", hours_to="0").hours_to == 24 * 60


def test_day_codes_read_9999_as_other_and_refuse_codes_the_manual_does_not_have():
    assert _slot(days="9999").days == OTHER_DAYS
    with pytest.raises(ValueError, match="規制曜日コード"):
        _slot(days="7")


def test_a_slot_without_any_field_is_not_a_slot():
    assert _slots() == []


def _vehicles(a: str = "", d: str = "") -> list[str]:
    return [a, "", "", d]


@pytest.mark.parametrize(("vehicles", "except_vehicles", "bicycle"), [
    # 対象の車両を書かない組は、車両の全部が対象。
    (_NO_VEHICLES, _NO_VEHICLES, True),
    # 区分 A の車両は自転車を含む。区分 D の自転車の位と軽車両の位は自転車を含み、歩行者の位は含まない。
    (_vehicles(a="1"), _NO_VEHICLES, True),
    (_vehicles(d="100"), _NO_VEHICLES, True),
    (_vehicles(d="100000"), _NO_VEHICLES, True),
    (_vehicles(d="1000000"), _NO_VEHICLES, False),
    # 除外の車両に自転車を含めば、自転車は対象でない。
    (_NO_VEHICLES, _vehicles(d="100"), False),
])
def test_a_slot_applies_to_bicycles_by_its_vehicle_codes(vehicles, except_vehicles, bicycle):
    assert _slot(days="2", vehicles=vehicles, except_vehicles=except_vehicles).applies_to_bicycles is bicycle
