"""地点の日の出・日没（観測の表示に添える時刻）。

天文計算は`astral`ライブラリ（暦計算、外部通信なし・決定論的）に委譲する。
"""

from datetime import date

from astral import Observer
from astral.sun import sun

from app.domain.time_zone import JST
from app.domain.route import Coordinates
from app.domain.strict_model import StrictModel


class Twilight(StrictModel):
    """地点の当日（JST）の日の出・日没。JST ISO文字列（例: "2026-08-29T05:12:00+09:00"）。"""

    sunrise: str
    sunset: str


def sunrise_sunset_jst(coordinates: Coordinates, on_date: date) -> Twilight | None:
    """`coordinates`地点の`on_date`（JST基準の暦日）における日の出・日没。

    太陽の中心が地平線と一致する瞬間（大気差を考慮）という一般的な定義の日の出・日没を返す。定義できない緯度ではNone。"""
    observer = Observer(latitude=coordinates.latitude, longitude=coordinates.longitude)
    try:
        s = sun(observer, date=on_date, tzinfo=JST)
    except ValueError:
        return None
    return Twilight(sunrise=s["sunrise"].isoformat(), sunset=s["sunset"].isoformat())
