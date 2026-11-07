"""気象庁の警報級の時系列（府県予報区ごと）のクライアント。

警報・注意報のページが時間帯ごとの危険度の表を描くのに読むJSONで、応答の形はここで解き、呼び出し元へは
`domain/jma_warning_timeline.py: WarningTimeline`で渡す。読むのは段のコード（`significancyParts`）だけで、雨量等の
見込みの値（`forecastParts`）は読まない。取得失敗はNoneを返し、「段がどこも注意報級でない」とは分ける。
"""

import re
from datetime import datetime, timedelta

import httpx
from cachetools import TTLCache

from app.domain.jma_warning_timeline import TimelineLevels, TimeSlot, WarningTimeline
from app.infrastructure.simple_api_client import UnexpectedShapeError, cached_fetch, get_json

JMA_WARNING_TIMELINE_URL_TEMPLATE = "https://www.jma.go.jp/bosai/warning_timeline/data/{office_code}.json"

# 時系列は警報・注意報の発表のたびに出し直される。
_TIMELINE_CACHE_TTL_SECONDS = 10 * 60

# コマの長さ（ISO 8601の期間）。気象庁は時間の単位でしか出さない。
_DURATION_HOURS = re.compile(r"PT(\d+)H")

def new_timeline_cache() -> TTLCache:
    """`fetch_warning_timeline`へ渡すキャッシュ。府県予報区（約50）が退避されない大きさで、鮮度はTTLで保つ。"""
    return TTLCache(maxsize=256, ttl=_TIMELINE_CACHE_TTL_SECONDS)


def _parse_slot(entry: dict) -> TimeSlot:
    duration = _DURATION_HOURS.fullmatch(entry["duration"])
    start = datetime.fromisoformat(entry["dateTime"])
    if duration is None or start.tzinfo is None:
        raise UnexpectedShapeError(f"warning timeline time define is not an hourly slot with an offset: {entry!r}")
    return TimeSlot(start=start, end=start + timedelta(hours=int(duration.group(1))))


def _parse_local(kind_type: str, local: dict, slots: tuple[TimeSlot, ...]) -> TimelineLevels:
    """1つの所の段の並び。段がコマの数だけ無ければ投げる（どの段がどのコマかを決められない）。"""
    codes = tuple(local["codes"])
    if len(codes) != len(slots):
        raise UnexpectedShapeError(f"warning timeline local has {len(codes)} levels for {len(slots)} slots")
    return TimelineLevels(
        kind_type=kind_type, area_name=local.get("areaName"), slots=slots, codes=codes,
        additions=tuple(local.get("additions", ())),
    )


def _parse_items(items: list | None, slots: tuple[TimeSlot, ...], into: dict[str, list[TimelineLevels]]) -> None:
    """区域ごとの段の並びを`into`へ足す（項目が無ければ何も足さない）。見込みの値だけの種別の欄は段を持たない。"""
    for item in items or ():
        for kind in item["kinds"]:
            into.setdefault(item["areaCode"], []).extend(
                _parse_local(part["type"], local, slots)
                for part in kind.get("significancyParts", ())
                for local in part["locals"]
            )


def _parse_timeline(payload: dict) -> WarningTimeline:
    class20: dict[str, list[TimelineLevels]] = {}
    class10: dict[str, list[TimelineLevels]] = {}
    for entry in payload["timeSeries"]:
        slots = tuple(map(_parse_slot, entry["timeDefines"]))
        _parse_items(entry.get("class20Items"), slots, class20)
        _parse_items(entry.get("class10Items"), slots, class10)
    return WarningTimeline(
        class20_levels={code: tuple(levels) for code, levels in class20.items()},
        class10_levels={code: tuple(levels) for code, levels in class10.items()},
    )


async def fetch_warning_timeline(
    client: httpx.AsyncClient, office_code: str, cache: TTLCache
) -> WarningTimeline:
    """府県予報区の警報級の時系列を取得する。"""

    async def fetch() -> WarningTimeline:
        payload = await get_json(
            client,
            JMA_WARNING_TIMELINE_URL_TEMPLATE.format(office_code=office_code),
            dict,
            "warning timeline is",
        )
        return _parse_timeline(payload)

    return await cached_fetch(
        "weather:jma-warning-timeline",
        fetch,
        cache=cache,
        key=office_code,
        office_code=office_code,
    )
