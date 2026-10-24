"""`domain/material_coverage_spec.py`——欠損率の見出しの表（`labeled_every_value`）が値の全部に見出しを付けること。

ここで見ないもの:
- 材料の宣言と、欠損率の測り方をカタログから導く一覧 → `test_material_catalog.py`
- 欠損率をDBで数えること → `test_material_coverage.py`
"""

from typing import Literal

import pytest

from app.domain import material_coverage_spec

Kind = Literal["a", "b"]


@pytest.mark.parametrize("labels", [{"a": "あ"}, {"a": "あ", "b": "い", "c": "う"}], ids=["見出しの無い値", "値に無い見出し"])
def test_headings_that_do_not_match_the_values_are_refused(labels):
    """管理画面の欠損率は母集団と欠損の扱いで束ねて見出しを付ける。見出しの無い値の材料は表から落ちる。"""
    with pytest.raises(ValueError, match="食い違う"):
        material_coverage_spec.labeled_every_value(Kind, labels)


def test_headings_for_every_value_are_kept_as_given():
    assert material_coverage_spec.labeled_every_value(Kind, {"b": "い", "a": "あ"}) == {"b": "い", "a": "あ"}
