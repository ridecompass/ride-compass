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


def test_regulation_hours_until_2400_are_the_end_of_the_day():
    """「2400」を24:00の分へ読めないと、終日の規制が時間帯の規制になる（時刻の読み替えの残りは派生の段のテストが通す）。"""
    slot = _slot(hours_from="0", hours_to="2400")
    assert (slot.hours_from, slot.hours_to) == (0, 24 * 60)


def _vehicles(a: str = "", d: str = "") -> list[str]:
    return [a, "", "", d]


@pytest.mark.parametrize(("vehicles", "bicycle"), [
    # 区分 A の車両は自転車を含む（自動車だけのコードは派生の段のテストが通す）。
    (_vehicles(a="1"), True),
    # 区分 D の自転車の位と軽車両の位は自転車を含み、歩行者の位は含まない。コードは車種の位を足した数。
    (_vehicles(d="100"), True),
    (_vehicles(d="100000"), True),
    (_vehicles(d="1000000"), False),
])
def test_vehicle_codes_include_bicycles(vehicles, bicycle):
    slot = _slot(vehicles=vehicles, except_vehicles=vehicles)
    assert (slot.vehicles, slot.vehicles_bicycle, slot.except_vehicles_bicycle) == (True, bicycle, bicycle)
