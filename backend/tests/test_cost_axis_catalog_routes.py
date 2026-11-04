"""費用の軸の公開読み取りAPI（`/api/cost-axes`）。画面が読む軸の並び・帳簿・見せ方と、定義がまだ無いときの404。

ここで見ないもの:
- 定義の形と検証 → `test_cost_axes.py`
- 定義の保存と管理APIでの書き込み → `test_cost_axis_admin_routes.py`
"""

import pytest
from fastapi.testclient import TestClient

from app.domain.cost_axes import AVOIDANCE_LABEL, EFFORT_AXES, CostAxisDefinitions, replace_cost_axes
from app.main import app

LENS = {"thresholds": [1.0], "band_labels": ["少ない", "多い"]}
DEFINITIONS = CostAxisDefinitions.model_validate({
    "effort": {axis_id: {"label": f"名前{axis_id}", "description": "", "icon_id": "icon", "lens": LENS}
               for axis_id in reversed(list(EFFORT_AXES))},
    "burden": {"vibration": {"label": "振動", "description": "揺れる", "icon_id": "wave", "lens": LENS,
                             "burden": {"kind": "categorical", "material": "class:surface_estimate",
                                        "per_km": {"paved": 0.0}}}},
    "total_lens": {"label": "総合", "description": "", "icon_id": "sum", "lens": LENS},
})


@pytest.fixture
def cost_axes():
    replace_cost_axes(DEFINITIONS)
    yield


def test_the_catalog_lists_the_effort_axes_in_the_code_order_then_the_burden_axes(cost_axes):
    """体力の軸は定義の書き順に依らずコードの表の順で、道の負担の軸が続く。道の負担の費目（材料と重さ）は画面へ出さない。"""
    body = TestClient(app).get("/api/cost-axes").json()

    assert [(axis["axis_id"], axis["ledger"]) for axis in body["axes"]] == [
        *((axis_id, "effort") for axis_id in EFFORT_AXES), ("vibration", "burden")]
    assert body["axes"][-1] == {"axis_id": "vibration", "ledger": "burden", "label": "振動", "description": "揺れる",
                     "icon_id": "wave", "lens": LENS}
    assert body["avoidance_label"] == AVOIDANCE_LABEL
