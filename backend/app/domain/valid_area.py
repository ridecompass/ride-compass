"""値が成り立つ範囲。区域や最寄りの点（観測所・情報提供地点）で決まる値の応答に添え、画面は今の地点がこの中に
ある間は取り直さない——境目をまたいだかを画面がこちらの数字（何km・何分）で決めず、値を決めたのと同じ事実で読むため。
"""

import math
from collections.abc import Sequence
from typing import Literal

import numpy as np
import shapely
from shapely.geometry import MultiPoint, MultiPolygon, Point, Polygon, box, mapping
from shapely.geometry.base import BaseGeometry

from app.domain.geo import LatLon, nearest_point_index
from app.domain.strict_model import StrictModel

#: 範囲の座標の小数の桁（度）。区域の境界は置くときに約10m（`scripts/fetch_jma_area_boundaries.py`）へ簡略化してあり、
#: それより細かい桁は応答を重くするだけ。
_DECIMALS = 5


class ValidArea(StrictModel):
    """値が成り立つ範囲。GeoJSON の MultiPolygon（座標は経度・緯度の順）。"""

    type: Literal["MultiPolygon"]
    coordinates: list[list[list[list[float]]]]


def valid_area_of(geometry: BaseGeometry, point: LatLon) -> ValidArea | None:
    """`geometry`を、地点`point`を含むときだけ範囲にする。含まない形（最寄りの区域へ寄せた・計算の境目で外れた）を
    渡すと、画面はすぐ外に出たと読んで取り直しを繰り返すので、範囲を持たない（取り直しの間隔だけで取り直す）。"""
    # 配布元の境界には自分と交わる形があり、そのままでは含むかの判定が例外になる。
    shape = geometry if geometry.is_valid else shapely.make_valid(geometry)
    here = Point(point.longitude, point.latitude)
    # 地点を含む1つの面だけを範囲にする（島の多い区域を丸ごと送ると重い。ほかの面へ渡ったら、そのときに取り直す）。
    part = next((polygon for polygon in _polygons(shape) if polygon.contains(here)), None)
    if part is None:
        return None
    multi = MultiPolygon([part])
    # 座標の値だけを丸める（形を作り直す丸めは、配布元の形で位相の例外になる）。
    rounded = shapely.transform(multi, lambda coordinates: np.round(coordinates, _DECIMALS))
    return ValidArea.model_validate(mapping(rounded))


def _polygons(geometry: BaseGeometry) -> list[Polygon]:
    """形を面の並びへ開く（直した形は、面と線の混ざった集まりになることがある）。"""
    if isinstance(geometry, Polygon):
        return [geometry]
    if hasattr(geometry, "geoms"):
        return [polygon for part in geometry.geoms for polygon in _polygons(part)]
    return []


def nearest_point_area(point: LatLon, points: Sequence[LatLon]) -> ValidArea | None:
    """地点`point`に最も近い点が、最も近い点であり続ける範囲（`points`のボロノイ図の、その点の領域）。

    最寄りは球面の距離で選ぶ（`domain/geo.py: nearest_point_index`）が、領域は地点の緯度で経度を縮めた平面で引く
    （狭い範囲では球面の最寄りと揃う）。点が1つなら外に出ることが無いので範囲を持たない。
    """
    nearest = nearest_point_index(point, points)
    if nearest is None or len(points) < 2:
        return None
    scale = math.cos(math.radians(point.latitude))
    plane = [(p.longitude * scale, p.latitude) for p in points]
    here = (point.longitude * scale, point.latitude)
    xs = [x for x, _ in plane] + [here[0]]
    ys = [y for _, y in plane] + [here[1]]
    frame = box(min(xs) - 1.0, min(ys) - 1.0, max(xs) + 1.0, max(ys) + 1.0)
    cells = shapely.voronoi_polygons(MultiPoint(plane), extend_to=frame)
    site = Point(plane[nearest])
    cell = next((c for c in cells.geoms if c.contains(site)), None)
    if cell is None:
        return None
    unscaled = shapely.transform(cell.intersection(frame), lambda coordinates: coordinates / [scale, 1.0])
    return valid_area_of(unscaled, point)
