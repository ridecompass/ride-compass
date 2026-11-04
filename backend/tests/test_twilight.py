"""`domain/twilight.py`——その日の日の出・日没（観測の表示に添える時刻）。

ここで見ないもの:
- 観測の応答へ日の出・日没を埋めること → `test_jma_amedas_service.py`・`test_weather_route.py`
"""

from datetime import date, datetime

from hypothesis import given
from hypothesis import strategies as st

from app.domain.route import Coordinates
from app.domain.twilight import sunrise_sunset_jst

#: 本番の範囲（日本の陸地の緯度・経度）。
PLACES = st.builds(Coordinates, latitude=st.floats(24.0, 45.5), longitude=st.floats(122.9, 146.0))


@given(PLACES, st.dates(min_value=date(2026, 1, 1), max_value=date(2027, 12, 31)))
def test_sunrise_and_sunset_fall_on_the_asked_japanese_day(place, on_date):
    """日本の暦日の日の出・日没で、日の出が日没より前（東経ではUTCの暦日で日の出と日没が入れ替わるが、JSTの暦日で返す）。"""
    twilight = sunrise_sunset_jst(place, on_date)
    assert twilight is not None
    sunrise = datetime.fromisoformat(twilight.sunrise)
    sunset = datetime.fromisoformat(twilight.sunset)

    assert sunrise.date() == sunset.date() == on_date
    assert sunrise < sunset
