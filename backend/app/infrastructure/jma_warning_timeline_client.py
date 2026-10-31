"""気象庁の警報級の時系列（府県予報区ごと）のクライアント。

警報・注意報のページが時間帯ごとの危険度の表を描くのに読むJSONで、応答の形はここで解き、呼び出し元へは
`domain/jma_warning_timeline.py: WarningTimeline`で渡す。読むのは段のコード（`significancyParts`）だけで、雨量等の
見込みの値（`forecastParts`）は読まない。取得失敗はNoneを返し、「段がどこも注意報級でない」とは分ける。
"""

import logging
import re
from datetime import datetime, timedelta

import httpx
from cachetools import TTLCache

from app.domain.jma_warning_timeline import TimelineLevels, TimeSlot, WarningTimeline
from app.infrastructure.simple_api_client import cached_fetch, get_json

JMA_WARNING_TIMELINE_URL_TEMPLATE = "https://www.jma.go.jp/bosai/warning_timeline/data/{office_code}.json"

# 時系列は警報・注意報の発表のたびに出し直される。
_TIMELINE_CACHE_TTL_SECONDS = 10 * 60

# コマの長さ（ISO 8601の期間）。気象庁は時間の単位でしか出さない。
_DURATION_HOURS = re.compile(r"PT(\d+)H")

logger = logging.getLogger("ridecompass.jma_warning_timeline_client")


def new_timeline_cache() -> TTLCache:
    """`fetch_warning_timeline`へ渡すキャッシュ。府県予報区（約50）が退避されない大きさで、鮮度はTTLで保つ。"""
    return TTLCache(maxsize=256, ttl=_TIMELINE_CACHE_TTL_SECONDS)


def _parse_slot(entry: object) -> TimeSlot | None:
    if not isinstance(entry, dict) or not isinstance(entry.get("dateTime"), str):
        return None
    duration = _DURATION_HOURS.fullmatch(entry.get("duration") or "")
    if duration is None:
        return None
    try:
        start = datetime.fromisoformat(entry["dateTime"])
    except ValueError:
        return None
    if start.tzinfo is None:
        return None
    return TimeSlot(start=start, end=start + timedelta(hours=int(duration.group(1))))


def _parse_slots(time_defines: object) -> tuple[TimeSlot, ...] | None:
    """系列のコマ。1つでも読めなければ、どの段がどのコマかを決められないのでNone。"""
    if not isinstance(time_defines, list) or not time_defines:
        return None
    slots = tuple(slot for slot in map(_parse_slot, time_defines) if slot is not None)
    return slots if len(slots) == len(time_defines) else None


def _parse_local(kind_type: str, local: object, slots: tuple[TimeSlot, ...]) -> TimelineLevels | None:
    """1つの所の段の並び。段がコマの数だけ無い・2桁の数字でないなら読めない（None）。付加事項は補足なので、
    配列でなければ無いとし、文字列でない要素は落とす。"""
    if not isinstance(local, dict):
        return None
    codes = local.get("codes")
    area_name = local.get("areaName")
    if (
        not isinstance(codes, list)
        or len(codes) != len(slots)
        or not all(isinstance(code, str) and code.isdigit() for code in codes)
        or not (area_name is None or isinstance(area_name, str))
    ):
        return None
    additions = local.get("additions")
    return TimelineLevels(
        kind_type=kind_type,
        area_name=area_name,
        slots=slots,
        codes=tuple(codes),
        additions=tuple(a for a in additions if isinstance(a, str)) if isinstance(additions, list) else (),
    )


def _parse_kind_levels(kind: object, slots: tuple[TimeSlot, ...]) -> tuple[list[TimelineLevels], int]:
    """1つの種別の欄の段の並びと、読めずに飛ばした数。見込みの値だけの欄は段を持たない。"""
    if not isinstance(kind, dict):
        return [], 1
    parts = kind.get("significancyParts")
    if parts is None:
        return [], 0
    if not isinstance(parts, list):
        return [], 1
    levels: list[TimelineLevels] = []
    unreadable = 0
    for part in parts:
        if not isinstance(part, dict) or not isinstance(part.get("type"), str) or not isinstance(part.get("locals"), list):
            unreadable += 1
            continue
        for local in part["locals"]:
            parsed = _parse_local(part["type"], local, slots)
            if parsed is None:
                unreadable += 1
            else:
                levels.append(parsed)
    return levels, unreadable


def _parse_items(
    items: object, slots: tuple[TimeSlot, ...], into: dict[str, list[TimelineLevels]]
) -> int:
    """区域ごとの段の並びを`into`へ足し、読めずに飛ばした数を返す。"""
    if not isinstance(items, list):
        return 0 if items is None else 1
    unreadable = 0
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("areaCode"), str) or not isinstance(item.get("kinds"), list):
            unreadable += 1
            continue
        for kind in item["kinds"]:
            levels, skipped = _parse_kind_levels(kind, slots)
            into.setdefault(item["areaCode"], []).extend(levels)
            unreadable += skipped
    return unreadable


def _parse_timeline(payload: dict, office_code: str) -> WarningTimeline:
    class20: dict[str, list[TimelineLevels]] = {}
    class10: dict[str, list[TimelineLevels]] = {}
    series = payload.get("timeSeries")
    series = series if isinstance(series, list) else []
    unreadable = 0
    for entry in series:
        slots = _parse_slots(entry.get("timeDefines")) if isinstance(entry, dict) else None
        if slots is None:
            unreadable += 1
            continue
        unreadable += _parse_items(entry.get("class20Items"), slots, class20)
        unreadable += _parse_items(entry.get("class10Items"), slots, class10)
    # 読めない部分は他の区域・種別を出すために飛ばすが、飛ばしたことは取得1回につき1行で出す（logging.md「外部データの読み飛ばし」）。
    if unreadable:
        logger.warning(
            "気象庁の警報級の時系列に読めない部分があり読み飛ばしました unreadable=%d series=%d office=%s",
            unreadable, len(series), office_code,
        )
    return WarningTimeline(
        class20_levels={code: tuple(levels) for code, levels in class20.items()},
        class10_levels={code: tuple(levels) for code, levels in class10.items()},
    )


async def fetch_warning_timeline(
    client: httpx.AsyncClient, office_code: str, cache: TTLCache
) -> WarningTimeline | None:
    """府県予報区の警報級の時系列を取得する。"""

    async def fetch() -> WarningTimeline:
        payload = await get_json(
            client,
            JMA_WARNING_TIMELINE_URL_TEMPLATE.format(office_code=office_code),
            dict,
            "warning timeline is",
        )
        return _parse_timeline(payload, office_code)

    return await cached_fetch(
        "weather:jma-warning-timeline",
        fetch,
        cache=cache,
        key=office_code,
        office_code=office_code,
    )
