"""気象庁の「警報級の時系列」（警報・注意報のページの、区域ごと・時間帯ごとの危険度の段）。

気象庁は府県予報区ごとに、二次細分区域（市町村等）と一次細分区域のそれぞれについて、種別（雷危険度・濃霧危険度等）ごとに
時間帯（コマ）ごとの段のコードを出す。段は気象庁が出したまま扱い、補間も読み替えもしない（気象庁が出したものをそのまま
重ねる表示に留めるため。docs/architecture/data-sources.md「気象業務法の予報業務許可」）。応答の形は
`infrastructure/jma_warning_timeline_client.py`がここの型へ解く。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum


class TimelineKind(StrEnum):
    """画面へ出す種別。種別を足すときは、ここと`TIMELINE_KIND_TYPES`へ1つずつ足す。"""

    THUNDER = "thunder"


#: 種別 → 時系列の`significancyParts`の`type`（気象庁の表の種別の名前）。
TIMELINE_KIND_TYPES: dict[TimelineKind, str] = {
    TimelineKind.THUNDER: "雷危険度",
}

#: 区域の中を陸と海で分けた段のうち、陸の側の所の名前。
LAND_AREA_NAME = "陸上"

#: 段のコードの十の位がこれ以上なら注意報級。気象庁のページの「注意報級以上」の絞り込みと同じ境目。
ADVISORY_TENS_DIGIT = 2


def is_advisory_level(code: str) -> bool:
    """段のコード（`01`・`20`等の2桁の数字）が注意報級以上か。"""
    return int(code) // 10 >= ADVISORY_TENS_DIGIT


@dataclass(frozen=True)
class TimeSlot:
    """時系列の1コマ。`end`はコマの終わり（次のコマの始まり）。"""

    start: datetime
    end: datetime


@dataclass(frozen=True)
class TimelineLevels:
    """区域1つ・種別1つの段の並び。`area_name`は区域の中を分けた所（「陸上」「海上」等）で、分けていなければNone。
    `codes`は`slots`と同じ並びで、`additions`（突風・ひょう等）はコマに依らずこの並び全体に付く。"""

    kind_type: str
    area_name: str | None
    slots: tuple[TimeSlot, ...]
    codes: tuple[str, ...]
    additions: tuple[str, ...]


@dataclass(frozen=True)
class WarningTimeline:
    """府県予報区1つの警報級の時系列。区域のコード → 種別ごとの段の並び。"""

    class20_levels: dict[str, tuple[TimelineLevels, ...]]
    class10_levels: dict[str, tuple[TimelineLevels, ...]]

    def levels_for(self, class20_code: str, class10_code: str, kind: TimelineKind) -> TimelineLevels | None:
        """区域の種別の段の並び。二次細分区域に無ければ一次細分区域で引き、どちらにも無ければNone。区域の中を所で
        分けているなら、走る所（陸上）の並びを選ぶ。それ以外の所（海上・山沿い等）だけなら選ばない。"""
        kind_type = TIMELINE_KIND_TYPES[kind]
        for levels in (self.class20_levels.get(class20_code), self.class10_levels.get(class10_code)):
            candidates = [entry for entry in levels or () if entry.kind_type == kind_type]
            for area_name in (None, LAND_AREA_NAME):
                chosen = next((entry for entry in candidates if entry.area_name == area_name), None)
                if chosen is not None:
                    return chosen
        return None


@dataclass(frozen=True)
class RoutePass:
    """ルートが区域を1度通る間。`start_index`・`end_index`はルートの点の番号で、通過は次の通過が始まる点で終わる。"""

    class20_code: str
    start_index: int
    end_index: int


def route_passes(codes: Sequence[str | None]) -> list[RoutePass]:
    """ルートの点ごとの区域（区域に入らない点はNone）を、通る順の通過にまとめる。続く同じ区域は1つの通過にし、
    区域に入らない点は飛ばす。同じ区域を離れてまた通れば、別の通過にする。境目はルートの点の間のどこかにあり、
    点の番号で区切るので、通過の端は辺1本分までずれる。"""
    passes: list[RoutePass] = []
    last_index = None
    for index, code in enumerate(codes):
        if code is None:
            continue
        last_index = index
        if passes and passes[-1].class20_code == code:
            continue
        if passes:
            passes[-1] = RoutePass(passes[-1].class20_code, passes[-1].start_index, index)
        passes.append(RoutePass(code, index, index))
    if passes and last_index is not None:
        passes[-1] = RoutePass(passes[-1].class20_code, passes[-1].start_index, last_index)
    return passes
