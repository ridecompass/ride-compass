"""`infrastructure/jma_warning_timeline_client.py`——気象庁の警報級の時系列の取得と、応答の形の解き方。

入口は`fetch_warning_timeline`で、気象庁の代役（respx）へ本物の`httpx.AsyncClient`を向けて呼ぶ。見るのは、段がコマのまま
（補間も読み替えもせず）区域・種別ごとに返ることと、読めない部分を飛ばして数えること。

ここで見ないもの:
- キャッシュの骨格（失敗をNoneへ倒す・キャッシュしない）→ `test_simple_api_client.py`
- 区域の段の並びを選ぶこと・注意報級の判定 → `test_jma_warning_timeline_domain.py`
"""

import copy
from datetime import datetime


from app.domain.jma_warning_timeline import TimelineLevels, TimeSlot
from app.infrastructure.jma_warning_timeline_client import fetch_warning_timeline, new_timeline_cache
from tests.fake_http import answering
from tests.jma_area_fixtures import (
    CLASS10_CODE,
    CLASS20_CODE,
    OFFICE_CODE,
    THUNDER_ADDITIONS,
    THUNDER_CODES,
    TIMELINE_DOCUMENT,
    TIMELINE_SLOT_STARTS,
)


def _three_hour_slots() -> tuple[TimeSlot, ...]:
    starts = [datetime.fromisoformat(start) for start in TIMELINE_SLOT_STARTS]
    return tuple(
        TimeSlot(start=start, end=datetime.fromisoformat(end))
        for start, end in zip(starts, [*TIMELINE_SLOT_STARTS[1:], "2026-10-23T00:00:00+09:00"], strict=True)
    )


async def test_levels_are_read_per_area_and_kind_as_the_slots_the_agency_gave():
    """段は気象庁のコマのまま並ぶ。画面はこのコマの時間帯をそのまま出すので、コマを詰め直すと気象庁が出していない
    時間帯を出してしまう。見込みの値（風向・雨量）の欄は段を持たない。"""
    timeline = await fetch_warning_timeline(answering(json=TIMELINE_DOCUMENT), OFFICE_CODE, new_timeline_cache())

    assert timeline is not None
    slots = _three_hour_slots()
    assert timeline.class20_levels[CLASS20_CODE] == (
        TimelineLevels(
            kind_type="風危険度", area_name=None, slots=slots,
            codes=("20", "20", "01", "01", "01", "01", "01", "01", "01", "01"), additions=(),
        ),
        TimelineLevels(
            kind_type="雷危険度", area_name=None, slots=slots,
            codes=tuple(THUNDER_CODES), additions=tuple(THUNDER_ADDITIONS),
        ),
    )
    assert timeline.class10_levels[CLASS10_CODE] == (
        TimelineLevels(kind_type="雷危険度", area_name=None, slots=slots, codes=("01",) * 10, additions=()),
    )


def _broken(mutate) -> dict:
    document = copy.deepcopy(TIMELINE_DOCUMENT)
    mutate(document)
    return document


def _thunder_local(document: dict) -> dict:
    return document["timeSeries"][0]["class20Items"][0]["kinds"][2]["significancyParts"][0]["locals"][0]

