"""`domain/registry.py`——一次属性の表示の宣言を、地図で1つの意味に読めない形で作れないこと。

入口は一次属性の宣言（`PrimaryAttributeSpec`）と表示の軸（`DisplayAxisSpec`）の組み立て。

ここで見ないもの:
- 一次属性の宣言の検証のうち、点の不透明度を点だけに付けること
- 属性をまたぐ宣言の関係（色相の起点・点の行と種別）→ `test_primary_attributes.py`
"""

import pytest
from pydantic import ValidationError

from app.domain.registry import DisplayAxisSpec, DisplayCategorySpec, PointThinningSpec, PrimaryAttributeSpec


def _rows(*keys: str, glyphs=None, radii=None) -> tuple[DisplayCategorySpec, ...]:
    glyphs = glyphs or (None,) * len(keys)
    radii = radii or (None,) * len(keys)
    return tuple(
        DisplayCategorySpec(key=key, label=key, values=(key,), description="d", glyph=glyph, radius_px=radius)
        for key, glyph, radius in zip(keys, glyphs, radii, strict=True)
    )


def _axis(categories, palette="nominal", **fields) -> DisplayAxisSpec:
    hue_slot = 0 if palette == "nominal" else None
    return DisplayAxisSpec(**{"key": "k", "property": "k", "palette": palette, "hue_slot": hue_slot, "categories": categories, **fields})


def _attribute(*axes: DisplayAxisSpec, geometry="point", **fields) -> PrimaryAttributeSpec:
    return PrimaryAttributeSpec(
        **{"attr_id": "p", "label": "点", "geometry": geometry, "display_axes": axes, "tile_kind": "poi", **fields}
    )


def _point_layer(rows: tuple[str, ...], glyph: str | None = "g") -> PrimaryAttributeSpec:
    glyphs = (f"{glyph}a", f"{glyph}b") if glyph else None
    return _attribute(
        _axis(_rows("a", "b", glyphs=glyphs)), point_thinning=PointThinningSpec(rows=rows, ratio_property="r"))


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


@pytest.mark.parametrize(
    "build",
    [
        pytest.param(lambda: _axis(_rows("a"), palette=None, hue_slot=1), id="色を持たない軸に色相の起点"),
        pytest.param(lambda: _axis(_rows("a"), palette=None, tone="dark"), id="色を持たない軸に段"),
        pytest.param(lambda: _axis(_rows("a"), hue_slot=None), id="順序を持たない列挙に色相の起点が無い"),
        pytest.param(
            lambda: _axis((*_rows("a"), DisplayCategorySpec(key="b", label="b", values=("a",), description="d"))),
            id="値が2つの行に属する",
        ),
        pytest.param(
            lambda: _axis((*_rows("a"), DisplayCategorySpec(key="a", label="b", values=("b",), description="d"))),
            id="行の鍵が重なる",
        ),
    ],
)
def test_an_axis_the_map_cannot_paint_one_way_is_refused(build):
    """色は先頭の軸の宣言から行数で配り、2つの行に属する値は一方の色でしか塗られず、凡例の絞り込みは行を鍵で持つ。"""
    with pytest.raises(ValidationError):
        build()


@pytest.mark.parametrize(
    "build",
    [
        pytest.param(lambda: _attribute(_axis(_rows("a"), palette=None)), id="先頭の軸が色を持たない"),
        pytest.param(lambda: _attribute(_axis(_rows("a")), _axis(_rows("b"))), id="2本目の軸が色を持つ"),
        pytest.param(lambda: _attribute(_axis(_rows("a")), geometry="area"), id="面が行を持つ"),
        pytest.param(lambda: _attribute(_axis(_rows("a")), tile_kind=None), id="読むタイルが無い"),
        pytest.param(
            lambda: _attribute(_axis(_rows("a", "b", glyphs=("g", None)))), id="絵記号が一部の行にだけある"),
        pytest.param(lambda: _attribute(_axis(_rows("a", "b", glyphs=("g", "g")))), id="絵記号が重なる"),
        pytest.param(lambda: _attribute(_axis(_rows("a", glyphs=("g",))), geometry="line"), id="線に絵記号"),
        pytest.param(
            lambda: _attribute(_axis(_rows("a")), _axis(_rows("b", glyphs=("g",)), palette=None)),
            id="2本目の軸に絵記号",
        ),
        pytest.param(
            lambda: _attribute(_axis(_rows("a", radii=(4,))), _axis(_rows("b", radii=(6,)), palette=None)),
            id="半径を持つ軸が2本",
        ),
        pytest.param(lambda: _attribute(_axis(_rows("a", radii=(4,))), geometry="line"), id="線に半径"),
        pytest.param(lambda: _attribute(_axis(_rows("a", "b", radii=(4, 4)))), id="半径が行の間で重なる"),
    ],
)
def test_an_attribute_the_map_cannot_draw_one_way_is_refused(build):
    """地図は先頭の軸で塗り、絵記号は点の先頭の軸の行ごとの形として、半径は1本の軸から描く。外れた宣言は地図に出ないか、
    形・大きさがどの行のものか決まらない。"""
    with pytest.raises(ValidationError):
        build()


def test_an_attribute_the_map_draws_one_way_is_accepted():
    attribute = _attribute(
        _axis(_rows("a", "b", glyphs=("g", "h"))), _axis(_rows("x", "y", radii=(4, 6)), palette=None, key="size"))
    assert len(attribute.display_axes) == 2
