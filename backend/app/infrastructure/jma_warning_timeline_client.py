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


def _shape_error(what: str) -> UnexpectedShapeError:
    return UnexpectedShapeError(f"warning timeline {what}")


def _parse_slot(entry: object) -> TimeSlot:
    if not isinstance(entry, dict) or not isinstance(entry.get("dateTime"), str):
        raise _shape_error("time define has no dateTime")
    duration = _DURATION_HOURS.fullmatch(entry.get("duration") or "")
    try:
        start = datetime.fromisoformat(entry["dateTime"])
    except ValueError as error:
        raise _shape_error(f"time define dateTime is not ISO: {entry['dateTime']!r}") from error
    if duration is None or start.tzinfo is None:
        raise _shape_error(f"time define is not an hourly slot with an offset: {entry!r}")
    return TimeSlot(start=start, end=start + timedelta(hours=int(duration.group(1))))


def _parse_slots(time_defines: object) -> tuple[TimeSlot, ...]:
    if not isinstance(time_defines, list) or not time_defines:
        raise _shape_error("time defines are not a list of slots")
    return tuple(map(_parse_slot, time_defines))


def _parse_local(kind_type: str, local: object, slots: tuple[TimeSlot, ...]) -> TimelineLevels:
    """1つの所の段の並び。段がコマの数だけの2桁の数字でなければ投げる。"""
    if not isinstance(local, dict):
        raise _shape_error("local is not a table")
    codes = local.get("codes")
    area_name = local.get("areaName")
    additions = local.get("additions", [])
    if (
        not isinstance(codes, list)
        or len(codes) != len(slots)
        or not all(isinstance(code, str) and code.isdigit() for code in codes)
        or not (area_name is None or isinstance(area_name, str))
        or not isinstance(additions, list)
        or not all(isinstance(addition, str) for addition in additions)
    ):
        raise _shape_error(f"local is not levels for each slot: {local!r}")
    return TimelineLevels(kind_type=kind_type, area_name=area_name, slots=slots, codes=tuple(codes), additions=tuple(additions))


def _parse_kind_levels(kind: object, slots: tuple[TimeSlot, ...]) -> list[TimelineLevels]:
    """1つの種別の欄の段の並び。見込みの値だけの欄は段を持たない。"""
    if not isinstance(kind, dict):
        raise _shape_error("kind is not a table")
    parts = kind.get("significancyParts", [])
    if not isinstance(parts, list) or not all(
        isinstance(part, dict) and isinstance(part.get("type"), str) and isinstance(part.get("locals"), list) for part in parts
    ):
        raise _shape_error("significancy parts are not a list of typed locals")
    return [_parse_local(part["type"], local, slots) for part in parts for local in part["locals"]]


def _parse_items(items: object, slots: tuple[TimeSlot, ...], into: dict[str, list[TimelineLevels]]) -> None:
    """区域ごとの段の並びを`into`へ足す（項目が無ければ何も足さない）。"""
    if items is None:
        return
    if not isinstance(items, list) or not all(
        isinstance(item, dict) and isinstance(item.get("areaCode"), str) and isinstance(item.get("kinds"), list)
        for item in items
    ):
        raise _shape_error("area items are not a list of areas with kinds")
    for item in items:
        for kind in item["kinds"]:
            into.setdefault(item["areaCode"], []).extend(_parse_kind_levels(kind, slots))


def _parse_timeline(payload: dict) -> WarningTimeline:
    class20: dict[str, list[TimelineLevels]] = {}
    class10: dict[str, list[TimelineLevels]] = {}
    series = payload.get("timeSeries")
    if not isinstance(series, list) or not all(isinstance(entry, dict) for entry in series):
        raise _shape_error("time series is not a list")
    for entry in series:
        slots = _parse_slots(entry.get("timeDefines"))
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
