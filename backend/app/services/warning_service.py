"""緯度経度からJMA警報・注意報バッジ向けの情報を組み立てるサービス。"""

from __future__ import annotations

import httpx
from cachetools import TTLCache

from app.domain.jma_warning import ActiveWarning, collect_active_warnings
from app.domain.route import Coordinates
from app.domain.valid_area import ValidArea, valid_area_of
from app.infrastructure.jma_area_boundaries import OutsideAreas, area_shape, resolve_point_area
from app.infrastructure.jma_warning_client import fetch_warning_documents
from app.domain.strict_model import StrictModel


class WeatherWarnings(StrictModel):
    warnings: list[ActiveWarning]
    #: 同じ警報が当たる範囲（地点を含む区域）。区域が分からない・地点を含まないならNone。
    valid_area: ValidArea | None = None


class WarningService:
    def __init__(self, http_client: httpx.AsyncClient, *, area_data_cache: TTLCache, warning_cache: TTLCache):
        self._http_client = http_client
        self._area_data_cache = area_data_cache
        self._warning_cache = warning_cache

    async def get_warnings(self, point: Coordinates) -> WeatherWarnings | None:
        """出発地点の警報・注意報バッジ情報を取得する。

        地点→区域→警報エリアの解決か、警報自体の取得に失敗したらNone（出ているかが分からない）。
        「警報なし」は、地点がどの区域にも入らないときと、取れた電文がその区域に警報を持たないときだけ。
        """
        resolved = await resolve_point_area(self._http_client, self._area_data_cache, point.latitude, point.longitude)
        if resolved is None:
            return None
        if isinstance(resolved, OutsideAreas):
            return WeatherWarnings(warnings=[])

        bulletins = await fetch_warning_documents(self._http_client, resolved.office_code, self._warning_cache)
        if bulletins is None:
            return None

        shape = await area_shape(resolved.class20_code)
        return WeatherWarnings(
            warnings=collect_active_warnings(bulletins, resolved.class20_code, resolved.class10_code),
            valid_area=None if shape is None else valid_area_of(shape, point),
        )
