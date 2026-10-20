"""値が成り立つ範囲。区域や最寄りの点（観測所・情報提供地点）で決まる値の応答に添え、この中では同じ値が当たると
約束する——境目をまたいだかを受け取る側が数字（何km・何分）で決めず、値を決めたのと同じ事実で読めるように。
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

#: 図を切る枠の、全点の外接矩形からの余白（平面の度）。端の点の領域は枠まで伸びる。
_FRAME_MARGIN_DEG = 1.0


class ValidArea(StrictModel):
    """値が成り立つ範囲。GeoJSON の MultiPolygon（座標は経度・緯度の順）。"""

    type: Literal["MultiPolygon"]
    coordinates: list[list[list[list[float]]]]


def valid_area_of(geometry: BaseGeometry, point: LatLon) -> ValidArea | None:
    """`geometry`のうち地点`point`を含む1つの面を範囲にする。含まない形（最寄りの区域へ寄せた・計算の境目で外れた）なら
    None——範囲は常に地点を含む。"""
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


class NearestPointCells:
    """点の並びのボロノイ図。点ごとに、その点が最寄りであり続ける範囲を引ける。

    作るのは点の表ごとに一度で、地点ごとには最寄りの点の領域を引くだけにする。最寄りは球面の距離で選ぶ
    （`domain/geo.py: nearest_point_index`）が、領域はメルカトルの平面で引く——どの緯度でも狭い範囲では縦横の縮みが揃い、
    隣り合う点の二等分線が球面の最寄りの境目と揃う。図は全点の外接矩形の周り`_FRAME_MARGIN_DEG`で切り、その外の地点は
    範囲を持たない。点が1つなら外に出ることが無いので範囲を持たない。
    """

    def __init__(self, points: Sequence[LatLon]):
        self._points = list(points)
        self._cells: list[BaseGeometry | None] = [None] * len(self._points)
        if len(self._points) < 2:
            return
        sites = [Point(p.longitude, _mercator_y(p.latitude)) for p in self._points]
        minx, miny, maxx, maxy = MultiPoint(sites).bounds
        frame = box(
            minx - _FRAME_MARGIN_DEG, miny - _FRAME_MARGIN_DEG, maxx + _FRAME_MARGIN_DEG, maxy + _FRAME_MARGIN_DEG
        )
        tree = shapely.STRtree(sites)
        for cell in shapely.voronoi_polygons(MultiPoint(sites), extend_to=frame).geoms:
            unprojected = shapely.transform(cell.intersection(frame), _unproject)
            # 同じ座標の点は1つの領域を分け合う。
            for index in tree.query(cell, predicate="contains"):
                self._cells[int(index)] = unprojected

    def area(self, point: LatLon) -> ValidArea | None:
        """地点`point`に最も近い点が、最も近い点であり続ける範囲。"""
        nearest = nearest_point_index(point, self._points)
        if nearest is None:
            return None
        cell = self._cells[nearest]
        return None if cell is None else valid_area_of(cell, point)


def _mercator_y(latitude: float) -> float:
    """緯度をメルカトルの縦の座標（経度と同じ度の目盛り）へ。"""
    return math.degrees(math.log(math.tan(math.pi / 4 + math.radians(latitude) / 2)))


def _unproject(coordinates: np.ndarray) -> np.ndarray:
    """メルカトルの平面の座標（経度・縦）を経度・緯度へ戻す。"""
    longitudes = coordinates[:, 0]
    latitudes = np.degrees(2 * np.arctan(np.exp(np.radians(coordinates[:, 1]))) - math.pi / 2)
    return np.column_stack([longitudes, latitudes])
