"""応答が添える範囲（`domain/valid_area.py: ValidArea`）を図形として読む。

範囲を添える応答のテストが、範囲が地点を含むかを確かめるのに使う。
"""

from shapely.geometry import Point, shape


def holds(area, point) -> bool:
    """範囲が地点（`latitude`・`longitude`を持つもの）を含むか（画面が「まだこの中にいる」と読むのと同じ問い）。"""
    return shape(area.model_dump()).contains(Point(point.longitude, point.latitude))
