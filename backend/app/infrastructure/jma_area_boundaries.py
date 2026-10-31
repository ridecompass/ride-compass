"""気象庁の「市町村等（気象警報等）」の区域の境界から、地点が属する区域のコードを引く。

区域のコードは地域マスタ(area.json)の`class20s`のキーと同じ体系で、市町村を分割した区域
（例: 奈良市西部・奈良市東部）もそれぞれ1つの区域として持つ。

境界は`scripts/fetch_jma_area_boundaries.py`が配布元のシェープファイルから作って
`BOUNDARY_PATH`へ置き、backendはそれを読むだけにする。配布元の版は`SOURCE_URL`のファイル名で
決まり、置き場の名前もそこから導く——版を上げたコードでは古い版の境界は選ばれない。
"""

import asyncio
import json
import logging
import threading
from pathlib import Path

import httpx
import shapely
from cachetools import LRUCache, TTLCache, cached
from shapely.geometry.base import BaseGeometry

from app.domain.stopwatch import elapsed_ms, start_timer
from app.domain.jma_area import NEAREST_LIMIT_DEG, ResolvedArea, resolve_area
from app.infrastructure.data_paths import DATA_DIR
from app.infrastructure.debug_log import log_throttled_warning
from app.infrastructure.jma_warning_client import fetch_area_data

logger = logging.getLogger("ridecompass.jma_area_boundaries")

#: 配布元（気象庁「予報区等GISデータ」）の版。版の一覧と更新の履歴は
#: https://www.data.jma.go.jp/developer/gis.html にある。
SOURCE_URL = "https://www.data.jma.go.jp/developer/gis/20260226_AreaInformationCity_weather_GIS.zip"

BOUNDARY_PATH = DATA_DIR / "jma_area" / (SOURCE_URL.rsplit("/", 1)[1].removesuffix(".zip") + ".json")

class AreaBoundaries:
    def __init__(self, codes: list[str], geometries: list[BaseGeometry]):
        self._codes = codes
        self._geometries = geometries
        self._index = {code: index for index, code in enumerate(codes)}
        self._tree = shapely.STRtree(geometries)

    def __len__(self) -> int:
        return len(self._codes)

    def shape(self, code: str) -> BaseGeometry | None:
        """区域のコードの境界。無いコードならNone。"""
        index = self._index.get(code)
        return None if index is None else self._geometries[index]

    def find(self, lat: float, lon: float) -> str | None:
        """地点を含む区域のコード。含む区域が無ければ`NEAREST_LIMIT_DEG`以内で最も近い区域。"""
        return self.find_many([(lat, lon)])[0]

    def find_many(self, points: list[tuple[float, float]]) -> list[str | None]:
        """地点（緯度, 経度）ごとの`find`。木を地点ごとに引かず、まとめて引く。"""
        # 含む判定は境界を準備済みの形で引けるため、距離の計算より2桁速い。距離は含まれない地点だけ測る。
        geometries = shapely.points([(lon, lat) for lat, lon in points])
        found: list[str | None] = [None] * len(points)
        point_indices, area_indices = self._tree.query(geometries, predicate="intersects")
        for point_index, area_index in zip(point_indices.tolist(), area_indices.tolist(), strict=True):
            if found[point_index] is None:
                found[point_index] = self._codes[area_index]
        missing = [index for index, code in enumerate(found) if code is None]
        if missing:
            point_indices, area_indices = self._tree.query_nearest(geometries[missing], max_distance=NEAREST_LIMIT_DEG)
            for point_index, area_index in zip(point_indices.tolist(), area_indices.tolist(), strict=True):
                original = missing[point_index]
                if found[original] is None:
                    found[original] = self._codes[area_index]
        return found


def write_boundaries(path: Path, areas: dict[str, BaseGeometry]) -> None:
    """区域のコード→境界を`path`へ書く。書き終えるまでは別名に書き、読む側に書きかけを掴ませない。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    payload = {code: shapely.to_wkb(geometry, hex=True) for code, geometry in areas.items()}
    temporary.write_text(json.dumps(payload), encoding="utf-8")
    temporary.replace(path)


@cached(cache=LRUCache(maxsize=1), lock=threading.Lock())
def _load_boundaries(path: Path) -> AreaBoundaries:
    started = start_timer()
    payload: dict[str, str] = json.loads(path.read_text(encoding="utf-8"))
    boundaries = AreaBoundaries(list(payload), list(shapely.from_wkb(list(payload.values()))))
    logger.info(
        "区域の境界を読み込んだ path=%s areas=%d ms=%d",
        path.name, len(boundaries), elapsed_ms(started),
    )
    return boundaries


class AreaBoundariesUnavailableError(Exception):
    """区域の境界を読めない。地点が区域の外（None）とは別の事実で、区域を引けたかが分からない。"""


async def find_class20_code(lat: float, lon: float) -> str | None:
    """地点が属する区域（area.jsonのclass20）のコード。どの区域にも入らなければNone。

    境界を読めなければ`AreaBoundariesUnavailableError`を送出する。初回だけ境界の読み込み（数秒かかる）が
    走るため、イベントループの外で読む。
    """
    boundaries = await _load_boundaries_or_raise()
    return boundaries.find(lat, lon)


async def _load_boundaries_or_raise() -> AreaBoundaries:
    try:
        return await asyncio.to_thread(_load_boundaries, BOUNDARY_PATH)
    except (OSError, ValueError, shapely.errors.GEOSException) as exc:
        log_throttled_warning(
            "weather:jma-area-boundaries",
            "区域の境界を読めないため警報・洪水予報の区域を引けません path=%s error=%r"
            "（scripts/fetch_jma_area_boundaries.pyで取得する）",
            BOUNDARY_PATH, exc,
        )
        raise AreaBoundariesUnavailableError from exc


async def find_class20_codes(points: list[tuple[float, float]]) -> list[str | None]:
    """地点（緯度, 経度）ごとの`find_class20_code`。境界を読めなければ`AreaBoundariesUnavailableError`を送出する。"""
    boundaries = await _load_boundaries_or_raise()
    return await asyncio.to_thread(boundaries.find_many, points)


async def area_shape(class20_code: str) -> BaseGeometry | None:
    """区域（area.jsonのclass20）の境界。無いコードならNone。境界は`find_class20_code`が読み込んだあとに呼ぶ。"""
    boundaries = await asyncio.to_thread(_load_boundaries, BOUNDARY_PATH)
    return boundaries.shape(class20_code)


class OutsideAreas:
    """地点がどの区域にも入らない（遠い海上）。陸の区域の警報・予報は当たらない。"""


OUTSIDE_AREAS = OutsideAreas()


async def resolve_point_area(
    http_client: httpx.AsyncClient, area_data_cache: TTLCache, lat: float, lon: float
) -> ResolvedArea | OutsideAreas | None:
    """地点が属する区域を、地域マスタ(area.json)で警報のエリアまで辿る。

    どの区域にも入らなければ`OUTSIDE_AREAS`。境界か地域マスタを読めない・辿れないならNone（区域が分からない）。
    """
    try:
        class20_code = await find_class20_code(lat, lon)
    except AreaBoundariesUnavailableError:
        return None
    if class20_code is None:
        return OUTSIDE_AREAS

    area_master = await fetch_area_data(http_client, area_data_cache)
    if area_master is None:
        return None

    resolved = resolve_area(class20_code, area_master)
    if resolved is None:
        log_throttled_warning(
            "weather:jma-area", "区域の境界が返したコードを地域マスタ(area.json)で警報のエリアへ辿れない class20=%s", class20_code
        )
    return resolved
