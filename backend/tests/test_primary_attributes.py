"""`domain/primary_attributes.py`——属性をまたいで1つの意味に読めない宣言と、点のレイヤーの行が描く種別から外れた宣言を断ること。

入口は`check_primary_attributes`・`check_point_rows`。宣言は架空の属性で与える（本番の宣言は読み込みの時点でこれを通る）。

ここで見ないもの:
- 属性1つの中の表示の宣言の検証 → `test_registry.py`
- 停止要因の点を地図でまとめるSQL → タイルを焼くテスト（`test_road_graph_repository_contracts.py`）
"""

from contextlib import nullcontext

import pytest

from app.domain.primary_attributes import check_point_rows, check_primary_attributes
from app.domain.registry import DisplayAxisSpec, DisplayCategorySpec, PrimaryAttributeSpec


def _attribute(attr_id: str, hue_slot: int = 0, values: tuple[str, ...] = ("a",)) -> PrimaryAttributeSpec:
    rows = tuple(DisplayCategorySpec(key=v, label=v, values=(v,), description="d", glyph=v) for v in values)
    axis = DisplayAxisSpec(key="k", property="k", palette="nominal", hue_slot=hue_slot, categories=rows)
    return PrimaryAttributeSpec(attr_id=attr_id, label=attr_id, geometry="point", display_axes=(axis,), tile_kind="poi")


@pytest.mark.parametrize(
    ("attributes", "refused"),
    [
        pytest.param((_attribute("a", 0), _attribute("a", 1)), True, id="同じidが2度"),
        pytest.param((_attribute("a", 0), _attribute("b", 0)), True, id="色相の起点が重なる"),
        pytest.param((_attribute("a", 0), _attribute("b", 1)), False, id="見分けられる"),
    ],
)
def test_attributes_that_cannot_be_told_apart_are_refused(attributes, refused):
    with pytest.raises(ValueError) if refused else nullcontext():
        check_primary_attributes(attributes)


@pytest.mark.parametrize(("drawn", "refused"), [({"a", "b", "c"}, True), ({"a", "b"}, False)], ids=["行に無い種別", "行と同じ種別"])
def test_point_rows_that_do_not_match_the_kinds_drawn_are_refused(drawn, refused):
    """行に無い種別の点は地図から消える。"""
    with pytest.raises(ValueError, match="食い違う") if refused else nullcontext():
        check_point_rows(_attribute("p", values=("a", "b")), drawn)
