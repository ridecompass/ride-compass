"""時刻で変わる値のコマの一覧（`domain/time_frames.py`）を配ることと、要求に載ったコマの印を、そのコマの判定の時刻へ戻すこと。

一覧は値の種類ごとに、作った元（道路網の置き場・予報の版）と範囲の始まり（今の正時）が同じ間だけプロセスの中で持つ。印は
今の一覧に無ければ断る（`StaleTimeFrameError`）。
"""

import asyncio
from datetime import datetime

from cachetools import LRUCache

from app.domain.strict_model import StrictModel
from app.domain.time_frames import TimeFrame, frame_range, frame_start
from app.domain.time_zone import JST
from app.domain.timed_regulations import regulation_frames
from app.domain.wind import wind_frames
from app.infrastructure import road_network_store
from app.infrastructure.debug_log import log_external_call, mark_failed
from app.infrastructure.msm_client import MsmUnavailableError
from app.services.weather_service import WeatherService

#: 持つ一覧の数。値の種類ごとに今の元と今の正時の1つずつで足り、正時をまたぐ間だけ前のものが残る。
FRAME_CACHE_SIZE = 4


def new_frame_cache() -> LRUCache[tuple[str, str, datetime], list[TimeFrame]]:
    """コマの一覧の持ち（鍵は値の種類・作った元・範囲の始まり）。"""
    return LRUCache(maxsize=FRAME_CACHE_SIZE)


class TimeFrames(StrictModel):
    #: 路面タイル（`/api/region/road-surface-tiles`の`frame`）のコマ。時刻で変わる交通規制の効き方で変わる。
    road_surface: list[TimeFrame]
    #: 風に依るレンズと道の窓（`/api/region/lens`・`/api/region/road-inspector`の`frame`）のコマ。予報が読めなければ空。
    lens: list[TimeFrame]


class TimeFrameService:
    def __init__(self, weather_service: WeatherService, cache: LRUCache[tuple[str, str, datetime], list[TimeFrame]]):
        self._weather_service = weather_service
        self._cache = cache

    async def frames(self) -> TimeFrames:
        """選べる出発時刻の範囲（`domain/time_frames.py: frame_range`）の、値の種類ごとのコマ。"""
        start, end = frame_range(datetime.now(JST))
        with log_external_call("region:time-frames") as fields:
            road_surface = await self._road_surface(start, end)
            try:
                lens = await self._lens(start, end)
            except MsmUnavailableError as exc:
                # 路面タイルのコマは予報によらないので、レンズのコマだけを空にして配る。
                mark_failed(fields, exc)
                lens = []
            fields["road_surface"], fields["lens"] = len(road_surface), len(lens)
        return TimeFrames(road_surface=road_surface, lens=lens)

    async def road_surface_at(self, key: str | None) -> datetime | None:
        """路面タイルのコマの印`key`の判定の時刻。Noneは時刻で変わらない規制だけで焼くこと。"""
        if key is None:
            return None
        return frame_start(await self._road_surface(*frame_range(datetime.now(JST))), key)

    async def lens_at(self, key: str | None) -> datetime | None:
        """レンズのコマの印`key`の判定の時刻。Noneは今。"""
        if key is None:
            return None
        return frame_start(await self._lens(*frame_range(datetime.now(JST))), key)

    async def _road_surface(self, start: datetime, end: datetime) -> list[TimeFrame]:
        cache_key = ("road_surface", road_network_store.current_generation(), start)
        frames = self._cache.get(cache_key)
        if frames is None:
            # 道路網を読むのと、全部の組の効き方を時刻ごとに求めるのは、イベントループの外で行う。
            frames = self._cache[cache_key] = await asyncio.to_thread(
                lambda: regulation_frames(road_network_store.current(), start, end))
        return frames

    async def _lens(self, start: datetime, end: datetime) -> list[TimeFrame]:
        version, times = await self._weather_service.get_forecast_times()
        cache_key = ("lens", version, start)
        frames = self._cache.get(cache_key)
        if frames is None:
            frames = self._cache[cache_key] = wind_frames(times, version, start, end)
        return frames
