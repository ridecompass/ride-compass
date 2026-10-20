"""緯度経度から暑さ指数（WBGT）警告バッジ向けの情報を組み立てるサービス。"""

from __future__ import annotations

from datetime import datetime, timedelta

import httpx
from cachetools import LRUCache, TTLCache

from app.domain.warning_levels import WarningBadgeLevel
from app.domain.route import Coordinates
from app.domain.geo import nearest_point_index
from app.domain.valid_area import ValidArea
from app.domain.wbgt import (
    FORECAST_SEARCH_WINDOW_HOURS,
    WbgtForecast,
    current_forecast,
    is_within_provision_period,
    wbgt_level,
)
from app.infrastructure.debug_log import log_throttled_warning
from app.infrastructure.wbgt_client import fetch_forecast, fetch_point_master
from app.services.nearest_point_areas import nearest_point_area
from app.domain.strict_model import StrictModel


class WbgtReading(StrictModel):
    level: WarningBadgeLevel
    label: str
    value: float


class WbgtStatus(StrictModel):
    #: 警告として出す段の値。提供期間の外で値が得られないときと、警告として意味を持たない低いレベルのときはNone。
    reading: WbgtReading | None
    #: 同じ情報提供地点の予測が当たる範囲（その地点が最寄りである範囲）。地点の表が無い・地点を含まないならNone。
    valid_area: ValidArea | None


class _Unknown:
    """提供期間の中で今の時刻の値が得られない（警戒レベルが分からない）。"""


_UNKNOWN = _Unknown()


class WbgtService:
    def __init__(
        self,
        http_client: httpx.AsyncClient,
        *,
        point_master_cache: TTLCache,
        forecast_cache: TTLCache,
        cells_cache: LRUCache,
    ):
        self._http_client = http_client
        self._point_master_cache = point_master_cache
        self._forecast_cache = forecast_cache
        self._cells_cache = cells_cache

    async def get_status(self, point: Coordinates, now: datetime) -> WbgtStatus | None:
        """出発地点の`now`（JST）時点の暑さ指数警戒レベルと、同じ予測が当たる範囲。

        段なし（`reading`が空）は、警告として意味を持たない低いレベルのときと、提供期間の外で今の時刻の値が
        得られない（取得の失敗も含む）ときだけ。提供期間の中で今の時刻の値が得られなければNone（警戒レベルが
        分からない）。
        """
        reading = await self._reading(point, now)
        if isinstance(reading, _Unknown):
            return None
        # 地点の表は予測を引くときに取ってあり（キャッシュ）、範囲のために外部へ問い合わせることはない。
        points = await fetch_point_master(self._http_client, self._point_master_cache)
        valid_area = nearest_point_area(point, points, self._cells_cache, table="wbgt") if points else None
        return WbgtStatus(reading=reading, valid_area=valid_area)

    async def _reading(self, point: Coordinates, now: datetime) -> WbgtReading | None | _Unknown:
        """出発地点の`now`（JST）時点の暑さ指数警戒レベル。段なしならNone。"""
        forecast = await self._current_forecast(point, now)
        if forecast is None or forecast.wbgt is None:
            # 提供期間の外は値が無いのが常で、失敗と出すと提供していない時期に「取得できませんでした」が出る。
            return _UNKNOWN if is_within_provision_period(now) else None

        level_info = wbgt_level(forecast.wbgt)
        if level_info is None:
            return None
        level, label = level_info
        return WbgtReading(level=level, label=label, value=forecast.wbgt)

    async def _current_forecast(self, point: Coordinates, now: datetime) -> WbgtForecast | None:
        points = await fetch_point_master(self._http_client, self._point_master_cache)
        if not points:
            return None

        nearest_index = nearest_point_index(point, points)
        if nearest_index is None:
            return None
        nearest = points[nearest_index]

        range_from = now - timedelta(hours=FORECAST_SEARCH_WINDOW_HOURS)
        forecasts = await fetch_forecast(self._http_client, nearest.no, range_from, now, self._forecast_cache)
        if forecasts is None:
            return None
        if not forecasts and is_within_provision_period(now):
            # 提供期間の中で発表が無いのは配信の止まりで、配信元の失敗ではないためクライアントは出さず、ここで出さないと未取得の理由が残らない。
            log_throttled_warning(
                "weather:wbgt-no-issuance",
                "暑さ指数の検索窓に発表がありません wbgt_no=%s range_from=%s range_to=%s",
                nearest.no, range_from.isoformat(), now.isoformat(),
            )
        return current_forecast(forecasts, now)
