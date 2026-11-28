"""交通規制の1件が、いつ・誰に効くかの判断。

規制は条件の組をいくつか持ち、組ごとに対象の時間・曜日・期間と、除外の時間・曜日・期間と、普通自転車も対象かを持つ。
組を持たない規制は、毎日いつでも全部の車両に効く。読み方は配布元の説明書（交通規制情報（拡張版_K_2.1）の説明書、別記2
「共通コード表」）に従う。配布のコードの読み替えは`infrastructure/source_models.py: regulation_slots`が持ち、ここへは
読み替えた値で届く。

**通る時刻に効くかは、この判断（`active_between`）の1つで決める。**ルート生成はレグの時間帯で、地図は時刻で、この判断を読む。
"""

from collections.abc import Callable, Sequence
from dataclasses import astuple, dataclass, fields
from datetime import date, datetime, timedelta
from functools import cache

import holidays
import numpy as np

from app.domain.search_graph import range_positions
from app.domain.time_zone import JST, as_jst

MINUTES_PER_DAY = 24 * 60

#: 規制曜日コードの「その他（規制内容を参照）」。曜日の条件を読めないので、対象の曜日なら毎日効くとみなし、除外の曜日なら除外は
#: 無いものとみなす（どちらも規制が効く側に倒す）。
OTHER_DAYS = 99
#: 規制曜日コード → (効く曜日（月曜が0）, 休日にも効くか)。休日は国民の祝日に関する法律の休日（祝日・振替休日・国民の休日）。
_DAY_CODES: dict[int, tuple[frozenset[int], bool]] = {
    1: (frozenset({5, 6}), False),  # 土曜・日曜
    2: (frozenset({5, 6}), True),  # 土曜・日曜・休日
    3: (frozenset({6}), True),  # 日曜・休日
    4: (frozenset({5}), False),  # 土曜日
    5: (frozenset({6}), False),  # 日曜日
    6: (frozenset(), True),  # 休日
}
DAY_CODES: frozenset[int] = frozenset({*_DAY_CODES, OTHER_DAYS})

#: 区分の材料`pedestrian_road`の値。その時刻に効いている規制が普通自転車も対象か。
BICYCLE_PROHIBITED = "bicycle"
BICYCLE_EXCEPTED = "not_bicycle"
PEDESTRIAN_ROAD_LABELS: dict[str, str] = {BICYCLE_PROHIBITED: "効いている（自転車も禁止）", BICYCLE_EXCEPTED: "効いている（自転車は除外）"}
#: 道路網の配列が持つ材料`pedestrian_road`の語彙（0は値なし）と、自転車も禁止・自転車は除外の番号。
PEDESTRIAN_ROAD_VOCAB: tuple[str | None, ...] = (None, *PEDESTRIAN_ROAD_LABELS)
PROHIBITED_CODE, EXCEPTED_CODE = PEDESTRIAN_ROAD_VOCAB.index(BICYCLE_PROHIBITED), PEDESTRIAN_ROAD_VOCAB.index(BICYCLE_EXCEPTED)

#: 組の値の欄の無いことを、数の配列で表す値（道路網の配列の`regulation_slot_values`）。
_NONE = -1


@dataclass(frozen=True)
class RegulationSlot:
    """規制の条件の組1つ。時間は0:00からの分（始まりは0〜1439、終わりは1〜1440で、始まりより前なら日をまたぐ）、期間は月日の
    数（MMDD。毎年くり返し、両端を含み、終わりが始まりより前なら年をまたぐ）、曜日は規制曜日コード。欄が無ければNone。"""

    applies_to_bicycles: bool
    hours_from: int | None = None
    hours_to: int | None = None
    days: int | None = None
    period_from: int | None = None
    period_to: int | None = None
    except_hours_from: int | None = None
    except_hours_to: int | None = None
    except_days: int | None = None
    except_period_from: int | None = None
    except_period_to: int | None = None

    @property
    def excludes(self) -> bool:
        """除外が効くか（除外の欄のどれかがあり、除外の曜日が「その他」でない）。"""
        has_any = any(v is not None for v in (self.except_hours_from, self.except_days, self.except_period_from))
        return has_any and self.except_days != OTHER_DAYS

    @property
    def time_invariant(self) -> bool:
        """時刻で変わらない組か: 時間が無いか終日で、曜日（「その他」は毎日）・期間・効く除外を持たない。"""
        return (self.hours_from in (None, 0) and self.hours_to in (None, MINUTES_PER_DAY)
                and self.days in (None, OTHER_DAYS) and self.period_from is None and not self.excludes)

    def as_values(self) -> tuple[int, ...]:
        """道路網の配列の1行（`SLOT_FIELDS`の並び。真偽は0/1、欄の無いものは-1）。"""
        return tuple(_NONE if value is None else int(value) for value in astuple(self))

    @classmethod
    def from_values(cls, values: Sequence[int]) -> "RegulationSlot":
        """`as_values`の逆。"""
        bicycle, *rest = (int(v) for v in values)
        return cls(bool(bicycle), *(None if v == _NONE else v for v in rest))


#: 組の欄の並び（道路網の配列の`regulation_slot_values`の列）。
SLOT_FIELDS: tuple[str, ...] = tuple(field.name for field in fields(RegulationSlot))


@cache
def _holidays(year: int) -> frozenset[date]:
    return frozenset(holidays.country_holidays("JP", years=year))


def _day_matches(code: int | None, day: date) -> bool:
    if code is None or code == OTHER_DAYS:
        return True
    weekdays, on_holidays = _DAY_CODES[code]
    return day.weekday() in weekdays or (on_holidays and day in _holidays(day.year))


def _in_period(start: int | None, end: int | None, day: date) -> bool:
    if start is None or end is None:
        return True
    month_day = day.month * 100 + day.day
    return start <= month_day <= end if start <= end else (month_day >= start or month_day <= end)


def _windows(hours: tuple[int | None, int | None], days: int | None, period: tuple[int | None, int | None],
             first: date, last: date) -> list[tuple[datetime, datetime]]:
    """`first`〜`last`の日に始まる、条件が当たる時間（日をまたぐ時間の曜日と期間は、始まる日で決める）。"""
    start = hours[0] if hours[0] is not None else 0
    end = hours[1] if hours[1] is not None else MINUTES_PER_DAY
    if end <= start:
        end += MINUTES_PER_DAY
    found = []
    day = first
    while day <= last:
        if _day_matches(days, day) and _in_period(*period, day):
            midnight = datetime(day.year, day.month, day.day, tzinfo=JST)
            found.append((midnight + timedelta(minutes=start), midnight + timedelta(minutes=end)))
        day += timedelta(days=1)
    return found


def _subtract(windows: list[tuple[datetime, datetime]], removed: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    for cut_start, cut_end in removed:
        windows = [piece for start, end in windows
                   for piece in ((start, min(end, cut_start)), (max(start, cut_end), end)) if piece[0] < piece[1]]
    return windows


def active_between(slot: RegulationSlot, start: datetime, end: datetime) -> bool:
    """組が`start`〜`end`（両端を含む。時刻帯の無い時刻はJSTの時刻として読む）のどこかで効くか。"""
    if slot.time_invariant:
        return True
    start, end = as_jst(start), as_jst(end)
    # 前の日に始まって日をまたぐ時間も見る。
    first, last = start.date() - timedelta(days=1), end.date()
    windows = _windows((slot.hours_from, slot.hours_to), slot.days, (slot.period_from, slot.period_to), first, last)
    if slot.excludes:
        windows = _subtract(windows, _windows((slot.except_hours_from, slot.except_hours_to), slot.except_days,
                                              (slot.except_period_from, slot.except_period_to), first, last))
    return any(window_start <= end and start < window_end for window_start, window_end in windows)


def _judge_slots(slot_values: np.ndarray, judge: Callable[[RegulationSlot], bool]) -> np.ndarray:
    """組の行（`SLOT_FIELDS`の並びの2次元の配列）ごとの`judge`。同じ条件の組は1回だけ判断する（規制の多くは、同じ時間・曜日の
    組を持つ）。"""
    values = np.asarray(slot_values, dtype=np.int16).reshape(-1, len(SLOT_FIELDS))
    if not len(values):
        return np.zeros(0, dtype=bool)
    unique, inverse = np.unique(values, axis=0, return_inverse=True)
    return np.array([judge(RegulationSlot.from_values(row)) for row in unique], dtype=bool)[inverse.reshape(-1)]


def active_slots(slot_values: np.ndarray, start: datetime, end: datetime) -> np.ndarray:
    """組の行ごとに、`start`〜`end`のどこかで効くか。"""
    return _judge_slots(slot_values, lambda slot: active_between(slot, start, end))


def invariant_slots(slot_values: np.ndarray) -> np.ndarray:
    """組の行ごとに、時刻で変わらない組か（`RegulationSlot.time_invariant`）。"""
    return _judge_slots(slot_values, lambda slot: slot.time_invariant)


def pedestrian_road_codes(bicycle: np.ndarray, excepted: np.ndarray, *, excepted_first: bool = False) -> np.ndarray:
    """区間ごとの（自転車も対象の規制が効くか、自転車は除外の規制が効くか）からの、材料`pedestrian_road`の番号
    （`PEDESTRIAN_ROAD_VOCAB`）。両方効く区間は自転車も禁止にし、`excepted_first`なら自転車は除外にする（ルートは両方を求めて
    倍率の大きい側を採る）。"""
    if excepted_first:
        return np.where(excepted, EXCEPTED_CODE, np.where(bicycle, PROHIBITED_CODE, 0)).astype(np.int16)
    return np.where(bicycle, PROHIBITED_CODE, np.where(excepted, EXCEPTED_CODE, 0)).astype(np.int16)


def active_kinds(
    rows: np.ndarray, edge_regulation_start: np.ndarray, edge_regulation_count: np.ndarray, edge_regulations: np.ndarray,
    regulation_slot_count: np.ndarray, regulation_slot_values: np.ndarray,
    slot_active: np.ndarray, slotless_active: bool,
) -> tuple[np.ndarray, np.ndarray]:
    """区間の行`rows`ごとの、(効いている規制に普通自転車も対象の組があるか, 普通自転車は除外の組があるか)。`slot_active`は
    組の行ごとに効いているか。組を持たない規制（いつでも全部の車両に効く）は、`slotless_active`なら自転車も対象として数える
    （時刻で変わる組だけを数えるときは数えない）。並びは道路網の配列の規制の欄
    （`domain/road_network.py: RoadNetwork`の`edge_regulation_*`・`regulation_slot_*`）。"""
    slot_count = np.asarray(regulation_slot_count, dtype=np.int64)
    slot_regulation = np.repeat(np.arange(len(slot_count)), slot_count)
    bicycle = np.asarray(regulation_slot_values, dtype=np.int16).reshape(-1, len(SLOT_FIELDS))[:, 0] == 1
    active = np.asarray(slot_active, dtype=bool)
    regulation_bicycle = np.zeros(len(slot_count), dtype=bool)
    regulation_excepted = np.zeros(len(slot_count), dtype=bool)
    np.logical_or.at(regulation_bicycle, slot_regulation, active & bicycle)
    np.logical_or.at(regulation_excepted, slot_regulation, active & ~bicycle)
    if slotless_active:
        regulation_bicycle |= slot_count == 0

    rows = np.asarray(rows, dtype=np.int64)
    count = np.asarray(edge_regulation_count, dtype=np.int64)[rows]
    first = np.asarray(edge_regulation_start, dtype=np.int64)[rows]
    owner = np.repeat(np.arange(len(rows)), count)
    position = range_positions(first, count)
    regulation = np.asarray(edge_regulations, dtype=np.int64)[position]
    row_bicycle = np.zeros(len(rows), dtype=bool)
    row_excepted = np.zeros(len(rows), dtype=bool)
    np.logical_or.at(row_bicycle, owner, regulation_bicycle[regulation])
    np.logical_or.at(row_excepted, owner, regulation_excepted[regulation])
    return row_bicycle, row_excepted
