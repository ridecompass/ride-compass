"""テストが費用の軸の定義（`domain/cost_axes.py`）を置くための足場。

本番は起動で表の定義を読み、無ければ起動しない。テストは`conftest.py`がテストごとに`cost_axes()`（体力の4軸だけ）を置き、
道のストレスの軸の要るテストは`cost_axes_declared`で差し替える。
"""

from collections.abc import Iterator
from contextlib import contextmanager

from app.domain.cost_axes import EFFORT_AXES, CostAxisDefinitions, current_cost_axes, replace_cost_axes

PRESENTATION = {"label": "軸", "description": "", "icon_id": "i", "lens": {"thresholds": [1.0], "band_labels": ["a", "b"]}}
#: 避けたい材料の道を重く見る道のストレスの軸のid。
BAD_AXIS = "bad"


def cost_axes(bad_material: str | None = None, bad_per_km: float = 1.0) -> CostAxisDefinitions:
    """体力の4軸と、`bad_material`を渡せば、その材料の値1の道を1kmあたり`bad_per_km`の重さと数える道のストレスの軸`BAD_AXIS`。"""
    burden = {} if bad_material is None else {BAD_AXIS: {**PRESENTATION, "burden": {
        "kind": "linear", "material": bad_material, "points": [[0.0, 0.0], [1.0, bad_per_km]]}}}
    return CostAxisDefinitions.model_validate({
        "effort": {axis_id: PRESENTATION for axis_id in EFFORT_AXES},
        "burden": burden,
        "total_lens": PRESENTATION,
    })


@contextmanager
def cost_axes_declared(definitions: CostAxisDefinitions) -> Iterator[None]:
    """`definitions`をプロセス内の費用の軸の定義に置き、抜けるときに前の定義へ戻す。"""
    previous = current_cost_axes()
    replace_cost_axes(definitions)
    try:
        yield
    finally:
        replace_cost_axes(previous)
