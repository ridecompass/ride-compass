"""交通規制（日本道路交通情報センターの拡張版標準フォーマット）の1件が、いつ・誰に効くかの判断。

コードの意味は配布元の説明書（拡張版標準フォーマット k_2.1）の共通コード表による。規制は条件の組を最大5つ持ち、
組ごとに対象の期間・時間・曜日・車両と、除外の期間・時間・曜日・車両を持つ（対象の i 番目と除外の i 番目が対になる）。
組の値は配布の文字列のまま受け、空の欄は空文字列で表す。
"""

from collections.abc import Iterable
from dataclasses import dataclass

#: 規制が効く時間帯の語彙。前ほど強い（長く効く）順に並べる。
ALL_DAY = "all_day"
TIMED = "timed"
REGULATION_HOURS: tuple[str, ...] = (ALL_DAY, TIMED)
REGULATION_HOURS_LABELS: dict[str, str] = {ALL_DAY: "終日", TIMED: "時間帯"}

#: 共通規制種別コードの歩行者用道路。
PEDESTRIAN_ROAD_KIND = "1"

#: 規制時間の終日（0:00〜24:00）。時刻は時分の数字で、先頭の0を持たない。
_WHOLE_DAY = ("0", "2400")


@dataclass(frozen=True)
class RegulationSlot:
    """規制の条件の組1つ。車両のコードは区分 A〜D の順に並べる。"""

    hours_from: str
    hours_to: str
    days: str
    period_from: str
    period_to: str
    vehicles: tuple[str, str, str, str]
    except_hours_from: str
    except_hours_to: str
    except_days: str
    except_period_from: str
    except_period_to: str
    except_vehicles: tuple[str, str, str, str]


def _has_digit(code: str, place: int) -> bool:
    """車両のコードは区分の中の車種ごとの位の数を足した10進数なので、車種を含むかは、その位が0でないかで分かる。
    `place`は1の位を1とする位置。"""
    return len(code) >= place and code[-place] != "0"


def _includes_bicycle(vehicles: tuple[str, str, str, str]) -> bool:
    """車両のコードが普通自転車を含むか。区分 A の車両（自動車・原付・軽車両の全部）、区分 D の自転車、区分 D の
    軽車両のどれかに当たれば含む。"""
    a, _b, _c, d = vehicles
    return _has_digit(a, 1) or _has_digit(d, 3) or _has_digit(d, 6)


def regulation_hours(slots: Iterable[RegulationSlot]) -> str:
    """規制が終日効くか（`ALL_DAY`）、時間帯で効くか（`TIMED`）。

    終日は、規制時間が無いか、組のどれかが0:00〜24:00で、どの組にも曜日・期間・除外の時間の指定が無いとき。
    """
    slots = list(slots)
    hours = [(s.hours_from, s.hours_to) for s in slots if s.hours_from or s.hours_to]
    if hours and _WHOLE_DAY not in hours:
        return TIMED
    limited = any(s.days or s.except_days or s.period_from or s.period_to or s.except_period_from
                  or s.except_period_to or s.except_hours_from or s.except_hours_to for s in slots)
    return TIMED if limited else ALL_DAY


def applies_to_bicycles(slots: Iterable[RegulationSlot]) -> bool:
    """普通自転車も規制の対象か。組のどれかが、対象の車両に自転車を含み、対になる除外の車両に自転車を含まないとき。
    対象の車両がどの組にも無い規制は、車両の全部を対象とみなす。"""
    slots = list(slots)
    if not any(any(s.vehicles) for s in slots):
        return not any(_includes_bicycle(s.except_vehicles) for s in slots)
    return any(_includes_bicycle(s.vehicles) and not _includes_bicycle(s.except_vehicles) for s in slots)

