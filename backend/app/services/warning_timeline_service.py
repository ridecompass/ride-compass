"""ルートが通る区域ごとに、気象庁の警報級の時系列の段を返すサービス。

段は気象庁のコマのまま返し、ルートのどこを何時に通るかと突き合わせるのは受け取る側に任せる（通る時刻は計画と走行の
進みで変わり、そのたびに上流を引き直さないため）。
"""

from __future__ import annotations

import asyncio
from datetime import datetime

import httpx
from cachetools import TTLCache
from pydantic import Field

from app.domain.jma_area import resolve_area
from app.domain.jma_warning_timeline import TimelineKind, WarningTimeline, is_advisory_level, route_passes
from app.domain.route import Coordinates
from app.domain.strict_model import StrictModel
from app.infrastructure.debug_log import log_throttled_warning
from app.infrastructure.jma_area_boundaries import AreaBoundariesUnavailableError, find_class20_codes
from app.infrastructure.jma_warning_client import fetch_area_data
from app.infrastructure.jma_warning_timeline_client import fetch_warning_timeline

#: 1回に受けるルートの点の数の上限。点の間を詰めすぎた要求で区域の引き当てを重くしない。
ROUTE_TIMELINE_MAX_POINTS = 10_000


class RouteTimelineRequest(StrictModel):
    """ルートを通る順に並べた点。"""

    points: list[Coordinates] = Field(min_length=1, max_length=ROUTE_TIMELINE_MAX_POINTS)


class TimelineSlotLevel(StrictModel):
    """1コマの段。`code`は気象庁の段のコードのままで、`advisory`はそれが注意報級以上か。"""

    start: datetime
    end: datetime
    code: str
    advisory: bool


class TimelineKindLevels(StrictModel):
    slots: list[TimelineSlotLevel]
    #: 付加事項（突風・ひょう等）。コマに依らず、この種別の段の並び全体に付く。
    additions: list[str]


class RouteAreaTimeline(StrictModel):
    """ルートが区域を1度通る間と、その区域の段。`start_index`・`end_index`は要求の点の番号で、通過は次の通過が始まる
    点で終わる。区域を離れてまた通れば、別の通過として並ぶ。"""

    area_code: str
    area_name: str
    start_index: int
    end_index: int
    #: 種別ごとの段。気象庁がその区域にその種別の段を出していなければ載せない。
    kinds: dict[TimelineKind, TimelineKindLevels]


class RouteWarningTimeline(StrictModel):
    #: 通る順の通過。区域に入らない点（遠い海上）しか無ければ空。
    areas: list[RouteAreaTimeline]


class WarningTimelineService:
    def __init__(self, http_client: httpx.AsyncClient, *, area_data_cache: TTLCache, timeline_cache: TTLCache):
        self._http_client = http_client
        self._area_data_cache = area_data_cache
        self._timeline_cache = timeline_cache

    async def get_route_timeline(self, points: list[Coordinates]) -> RouteWarningTimeline | None:
        """ルートの点を区域の通過へまとめ、区域ごとの段を返す。区域の境界・地域マスタ・時系列のどれかを読めない、
        区域を府県予報区まで辿れないならNone（段が分からない）。"""
        try:
            codes = await find_class20_codes([(point.latitude, point.longitude) for point in points])
        except AreaBoundariesUnavailableError:
            return None
        passes = route_passes(codes)
        if not passes:
            return RouteWarningTimeline(areas=[])

        area_master = await fetch_area_data(self._http_client, self._area_data_cache)
        if area_master is None:
            return None
        resolved = {code: resolve_area(code, area_master) for code in {route_pass.class20_code for route_pass in passes}}
        unresolved = sorted(code for code, area in resolved.items() if area is None)
        if unresolved:
            log_throttled_warning(
                "weather:jma-area", "区域の境界が返したコードを地域マスタ(area.json)で警報のエリアへ辿れない class20=%s", unresolved
            )
            return None

        areas_by_code = {code: area for code, area in resolved.items() if area is not None}
        office_codes = sorted({area.office_code for area in areas_by_code.values()})
        fetched = await asyncio.gather(
            *(fetch_warning_timeline(self._http_client, office, self._timeline_cache) for office in office_codes)
        )
        if any(timeline is None for timeline in fetched):
            return None
        timelines: dict[str, WarningTimeline] = dict(zip(office_codes, fetched, strict=True))

        areas = []
        for route_pass in passes:
            area = areas_by_code[route_pass.class20_code]
            timeline = timelines[area.office_code]
            entry = area_master.class20s.get(route_pass.class20_code)
            areas.append(
                RouteAreaTimeline(
                    area_code=route_pass.class20_code,
                    area_name=(entry.name if entry is not None and entry.name else route_pass.class20_code),
                    start_index=route_pass.start_index,
                    end_index=route_pass.end_index,
                    kinds=_kind_levels(timeline, area.class20_code, area.class10_code),
                )
            )
        return RouteWarningTimeline(areas=areas)


def _kind_levels(timeline: WarningTimeline, class20_code: str, class10_code: str) -> dict[TimelineKind, TimelineKindLevels]:
    kinds: dict[TimelineKind, TimelineKindLevels] = {}
    for kind in TimelineKind:
        levels = timeline.levels_for(class20_code, class10_code, kind)
        if levels is None:
            continue
        kinds[kind] = TimelineKindLevels(
            slots=[
                TimelineSlotLevel(start=slot.start, end=slot.end, code=code, advisory=is_advisory_level(code))
                for slot, code in zip(levels.slots, levels.codes, strict=True)
            ],
            additions=list(levels.additions),
        )
    return kinds
