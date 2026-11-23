"""費用の軸の公開読み取りAPI（`/api/cost-axes`）。画面が読む軸の並び・帳簿・見せ方と、レンズごとの値が変わる走る条件。

ここで見ないもの:
- 定義の形と検証 → `test_cost_axes.py`
- 定義の保存と管理APIでの書き込み → `test_cost_axis_admin_routes.py`
"""

import json

import pytest
from fastapi.testclient import TestClient

from app.domain.cost_axes import (
    EFFORT_AXES, CostAxisDefinitions, replace_cost_axes,
)
from app.domain.display_palette import cost_series_colors
from app.main import app

LENS = {"thresholds": [1.0], "band_labels": ["少ない", "多い"]}
DEFINITIONS = CostAxisDefinitions.model_validate({
    "effort": {axis_id: {"label": f"名前{axis_id}", "description": "", "icon_id": "icon", "lens": LENS}
               for axis_id in reversed(list(EFFORT_AXES))},
    "burden": {"steep": {"label": "急坂", "description": "", "icon_id": "slope", "lens": LENS,
                         "burden": {"kind": "linear", "material": "gradient_percent", "points": [(0.0, 0.0)]}},
               "vibration": {"label": "振動", "description": "揺れる", "icon_id": "wave", "lens": LENS,
                             "burden": {"kind": "categorical", "material": "class:surface_estimate",
                                        "per_km": {"paved": 0.0}}}},
    "total_lens": {"label": "総合", "description": "", "icon_id": "sum", "lens": LENS},
})


@pytest.fixture
def cost_axes():
    replace_cost_axes(DEFINITIONS)
    yield


def test_the_catalog_lists_the_effort_axes_in_the_code_order_then_the_burden_axes(cost_axes):
    """体力の軸は定義の書き順に依らずコードの表の順で、道のストレスの軸が続く。道のストレスの費目（材料と重さ）は画面へ出さない。"""
    body = TestClient(app).get("/api/cost-axes").json()

    assert [(axis["axis_id"], axis["ledger"]) for axis in body["axes"]] == [
        *((axis_id, "effort") for axis_id in EFFORT_AXES), ("steep", "burden"), ("vibration", "burden")]
    vibration = {key: value for key, value in body["axes"][-1].items() if key != "map_lens"}
    assert vibration == {"axis_id": "vibration", "ledger": "burden", "label": "振動", "description": "揺れる",
                         "icon_id": "wave", "color": cost_series_colors(len(body["axes"]))[-1], "lens": LENS}


@pytest.mark.parametrize(("lens_id", "material_conditions", "reads_bearing"), [
    ("total", ["speed_kmh", "at"], True),
    ("ascent", ["speed_kmh", "at"], True),
    ("stopping", ["speed_kmh"], False),
    ("steep", [], True),
    ("vibration", [], False),
])
def test_each_lens_carries_only_the_ride_conditions_that_change_its_value(cost_axes, lens_id, material_conditions,
                                                                           reads_bearing):
    """止まる回数の慣性は速度だけで変わり、道のストレスの軸は区分の材料ならどの走る条件でも変わらず数値の材料なら向きだけで変わり、ほかの体力の軸（登坂が代表）と総合は向き・速度・時刻で変わる。材料の
    要求へ載せる条件（時刻・速度）と、塗る向きを走行方位で選ぶか（式が走行方位を読むか）を、レンズごとに配る。"""
    body = TestClient(app).get("/api/cost-axes").json()
    lenses = {body["total_lens"]["lens_id"]: body["total_lens"], **{axis["axis_id"]: axis for axis in body["axes"]}}

    lens = lenses[lens_id]["map_lens"]
    assert lens["material_conditions"] == material_conditions
    assert ('"bearing_deg"' in json.dumps(lens["formula"])) is reads_bearing
