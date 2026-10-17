"""`domain/registry.py`——点の間引きの順の宣言。

入口は一次属性の宣言（`PrimaryAttributeSpec`）の組み立て。

ここで見ないもの:
- 一次属性の宣言（`PrimaryAttributeSpec`等）の検証のうち、間引きの順のほか（点の不透明度を点だけに付けること）
"""

import pytest
from pydantic import ValidationError

from app.domain.registry import DisplayAxisSpec, DisplayCategorySpec, PointThinningSpec, PrimaryAttributeSpec


def _point_layer(rows: tuple[str, ...], glyph: str | None = "g") -> PrimaryAttributeSpec:
    categories = tuple(
        DisplayCategorySpec(key=key, label=key, values=(key,), description="d", glyph=glyph) for key in ("a", "b"))
    return PrimaryAttributeSpec(
        attr_id="p", label="点", geometry="point",
        display_axes=(DisplayAxisSpec(key="k", property="k", categories=categories),),
        point_thinning=PointThinningSpec(rows=rows, ratio_property="r"))


@pytest.mark.parametrize("rows", [("a",), ("a", "a", "b"), ("a", "b", "c")])
def test_a_thinning_order_that_does_not_rank_every_row_once_is_refused(rows):
    """順に無い行の点は地図の式で最後に回り、同じ行を2度並べると先の順位だけが効く——どちらも宣言と違う順で残る。"""
    with pytest.raises(ValidationError, match="1度ずつ全部"):
        _point_layer(rows)


def test_thinning_round_points_is_refused():
    """地図は重なった丸い点を省けないので、宣言しても間引かれない。"""
    with pytest.raises(ValidationError, match="絵記号で描く点にだけ"):
        _point_layer(("a", "b"), glyph=None)


def test_a_thinning_order_ranking_every_row_once_is_accepted():
    assert _point_layer(("b", "a")).point_thinning == PointThinningSpec(rows=("b", "a"), ratio_property="r")
