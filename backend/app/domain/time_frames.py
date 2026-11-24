"""時刻で変わる値のコマ（始まり〜終わりの間と、その間の版の印）。時刻で変わる値を配る口は、選べる出発時刻の範囲のコマの一覧を
配り、要求にはコマの印だけを受ける（docs/architecture/design-principles.md「構造仕様」の18）。コマの作り方は値の種類ごとに決め、
画面はコマが何で変わるかを知らない。
"""

from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Annotated

from pydantic import Field

from app.domain.strict_model import StrictModel
from app.domain.time_zone import as_jst
from app.domain.weather_elements import MSM_FORECAST_HOURS


#: 要求に載るコマの印（配った一覧の`key`）。
TimeFrameKey = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[0-9A-Za-z-]+$")]


class TimeFrame(StrictModel):
    """コマ1つ。`start`以上`end`未満の時刻は、同じ値になる。`key`は版の印（値が同じコマどうしは同じ印でよい）。"""

    start: datetime
    end: datetime
    key: str


class StaleTimeFrameError(LookupError):
    """今のコマの一覧に無い印（終わったコマ・版の変わる前のコマ）。画面は一覧を読み直してから求め直す。"""


def frame_range(now: datetime) -> tuple[datetime, datetime]:
    """選べる出発時刻の範囲（今の正時から、予報の時間ぶん先の正時の終わりまで）。"""
    start = as_jst(now).replace(minute=0, second=0, microsecond=0)
    return start, start + timedelta(hours=MSM_FORECAST_HOURS + 1)


def frames_from(instants: Sequence[datetime], keys: Sequence[str], end: datetime) -> list[TimeFrame]:
    """昇順の時刻`instants`から次の時刻（最後は`end`）までを、その時刻の印`keys`のコマにする。隣どうしで印が同じなら1つにする。"""
    frames: list[TimeFrame] = []
    for instant, following, key in zip(instants, [*instants[1:], end], keys, strict=True):
        if frames and frames[-1].key == key and frames[-1].end == instant:
            frames[-1] = TimeFrame(start=frames[-1].start, end=following, key=key)
        elif instant < following:
            frames.append(TimeFrame(start=instant, end=following, key=key))
    return frames


def frame_start(frames: Sequence[TimeFrame], key: str) -> datetime:
    """印`key`のコマの始まり（コマの中のどの時刻も同じ値になるので、判定にはこの時刻を使う）。一覧に無ければ投げる。"""
    for frame in frames:
        if frame.key == key:
            return frame.start
    raise StaleTimeFrameError(f"今のコマの一覧に無い印です: {key}")
