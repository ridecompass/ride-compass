"""時刻で変わる値のコマの一覧（`domain/time_frames.py`）を配ることと、要求に載ったコマの印を、そのコマの判定の時刻へ戻すこと。

一覧は値の種類ごとに、作った元（道路網の置き場・予報の版）と範囲の始まり（今の正時）が同じ間だけプロセスの中で持つ。印は
今の一覧に無ければ断る（`StaleTimeFrameError`）。
"""

import asyncio
from datetime import datetime

from cachetools import LRUCache

from app.domain.road_network import RoadNetwork
from app.domain.strict_model import StrictModel
from app.domain.time_frames import TimeFrame, frame_range, frame_start
from app.domain.time_zone import JST
from app.domain.timed_regulations import regulation_frames
from app.domain.wind import LensTimeFrame, wind_frames
from app.infrastructure import road_network_store
from app.infrastructure.debug_log import log_external_call, mark_failed
from app.infrastructure.msm_client import MsmUnavailableError
from app.services.weather_service import WeatherService

#: 読む間に予報が入れ替わったときに読み直す回数の上限（入れ替えは数分ごとにしか起きない）。
_FORECAST_READ_ATTEMPTS = 3

#: 持つ一覧の数。値の種類ごとに今の元と今の正時の1つずつで足り、正時をまたぐ間だけ前のものが残る。
FRAME_CACHE_SIZE = 4


def new_frame_cache() -> LRUCache[tuple[str, str, datetime], list[TimeFrame]]:
    """コマの一覧の持ち（鍵は値の種類・作った元・範囲の始まり）。"""
    return LRUCache(maxsize=FRAME_CACHE_SIZE)


class TimeFrames(StrictModel):
    #: 路面タイル（`/api/region/road-surface-tiles`の`frame`）のコマ。時刻で変わる交通規制の効き方で変わる。道路網が読めなければ空。
    road_surface: list[TimeFrame]
    #: 風に依るレンズと道の窓（`/api/region/lens-tiles`・`/api/region/road-inspector`の`frame`）のコマ。予報が読めなければ空。
    lens: list[LensTimeFrame]


class TimeFrameService:
    def __init__(self, weather_service: WeatherService, cache: LRUCache[tuple[str, str, datetime], list[TimeFrame]]):
        self._weather_service = weather_service
        self._cache = cache

    async def frames(self) -> TimeFrames:
        """選べる出発時刻の範囲（`domain/time_frames.py: frame_range`）の、値の種類ごとのコマ。"""
        start, end = frame_range(datetime.now(JST))
        # 値の種類どうしは元が違う（道路網・予報）ので、読めない種類のコマだけを空にして配る（片方が読めないために、もう片方の値まで
        # 取れなくしない）。空の種類の要求は印を載せず、路面タイルは時刻で変わらない規制だけで、レンズは今の風で求まる。
        with log_external_call("region:time-frames") as fields:
            try:
                road_surface = await self._road_surface(await asyncio.to_thread(road_network_store.current), start, end)
            except (OSError, ValueError) as exc:
                mark_failed(fields, exc)
                road_surface = []
            try:
                lens = await self._lens(start, end)
            except MsmUnavailableError as exc:
                mark_failed(fields, exc)
                lens = []
            fields["road_surface"], fields["lens"] = len(road_surface), len(lens)
        return TimeFrames(road_surface=road_surface, lens=lens)

    async def road_surface_at(self, key: str | None, network: RoadNetwork) -> datetime | None:
        """道路網`network`の路面タイルのコマの印`key`の判定の時刻。Noneは時刻で変わらない規制だけで焼くこと。"""
        if key is None:
            return None
        return frame_start(await self._road_surface(network, *frame_range(datetime.now(JST))), key)

    async def lens_at(self, key: str | None) -> datetime | None:
        """レンズのコマの印`key`の判定の時刻。Noneは今。"""
        if key is None:
            return None
        return frame_start(await self._lens(*frame_range(datetime.now(JST))), key)

    async def _road_surface(self, network: RoadNetwork, start: datetime, end: datetime) -> list[TimeFrame]:
        cache_key = ("road_surface", road_network_store.directory_name(network.revision), start)
        frames = self._cache.get(cache_key)
        if frames is None:
            # 全部の組の効き方を時刻ごとに求めるのは、イベントループの外で行う。
            frames = self._cache[cache_key] = await asyncio.to_thread(regulation_frames, network, start, end)
        return frames

    async def _lens(self, start: datetime, end: datetime) -> list[TimeFrame]:
        # 持ちは版（小さなファイルを読むだけ）で先に引き、外れたときだけ予報の時刻の並びを読む。
        for _ in range(_FORECAST_READ_ATTEMPTS):
            version = self._weather_service.forecast_version()
            cache_key = ("lens", version, start)
            if (frames := self._cache.get(cache_key)) is not None:
                return frames
            if (forecast := await self._weather_service.get_forecast_times(version)) is not None:
                frames = self._cache[cache_key] = wind_frames(forecast, version, start, end)
                return frames
        raise MsmUnavailableError("MSMの予報が入れ替わり続け、版と時刻の並びをそろえて読めません")
