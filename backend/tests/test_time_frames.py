"""時刻で変わる値のコマ（`domain/time_frames.py`）と、値の種類ごとのコマの作り方（`domain/timed_regulations.py: regulation_frames`・
`domain/wind.py: wind_frames`）。

ここで見ないもの:
- 組が時刻に効くかの判断 → `test_traffic_regulation.py`
- 口がコマの印を判定の時刻へ戻し、古い印を断ること → `test_region_lens.py`・`test_region_routes.py`
"""

from datetime import datetime, timedelta

import numpy as np
import pytest

from app.domain.road_network_build import NetworkRegulations
from app.domain.time_frames import StaleTimeFrameError, frame_start
from app.domain.time_zone import JST
from app.domain.timed_regulations import regulation_frames
from app.domain.traffic_regulation import SLOT_FIELDS, RegulationSlot
from app.domain.wind import wind_frames
from tests.road_network_fixture import road_network

DAY = datetime(2026, 11, 24, tzinfo=JST)
#: 毎日8:00〜20:00に効く組。
DAYTIME = RegulationSlot(True, hours_from=8 * 60, hours_to=20 * 60)


def _network(*slots: RegulationSlot):
    """区間1本に、組`slots`を持つ規制が1件当たった道路網（組が無ければ、規制はいつでも効く）。"""
    return road_network(
        {1: (35.0, 139.0), 2: (35.0, 139.001)}, {(1, 0): (1, 2)},
        regulations=NetworkRegulations(
            regulation_count=1, hit_way=np.array([1]), hit_segment=np.array([0]), hit_regulation=np.array([0]),
            slot_regulation=np.zeros(len(slots), dtype=np.int64),
            slot_values=np.array([slot.as_values() for slot in slots], dtype=np.int16).reshape(len(slots), len(SLOT_FIELDS))))


def _spans(frames) -> list[tuple[int, int, str]]:
    """コマごとの (始まり, 終わり)（範囲の始まりからの時間）と印。"""
    return [(int((frame.start - DAY) / timedelta(hours=1)), int((frame.end - DAY) / timedelta(hours=1)), frame.key)
            for frame in frames]


def test_the_road_frames_split_where_the_timed_regulations_change_and_share_a_key_for_the_same_state():
    """効き方の同じ間は日をまたいでも同じ印になり、同じ印のタイルを読み直さない。"""
    spans = _spans(regulation_frames(_network(DAYTIME), DAY, DAY + timedelta(days=2)))

    assert [(start, end) for start, end, _ in spans] == [(0, 8), (8, 20), (20, 32), (32, 44), (44, 48)]
    keys = [key for *_, key in spans]
    assert keys[0] == keys[2] == keys[4] != keys[1] == keys[3]


def test_without_timed_regulations_the_road_frames_are_one_frame():
    """時刻で変わる組が無ければ、範囲の全体が1つのコマで、時刻が進んでもタイルを読み直さない。"""
    frames = regulation_frames(_network(), DAY, DAY + timedelta(days=2))

    assert [(start, end) for start, end, _ in _spans(frames)] == [(0, 48)]


def test_the_wind_frames_take_the_nearest_hour_of_the_forecast():
    """時刻は最も近い予報の正時の風を引き、ちょうど中間は後の正時の風を引く。予報の時刻の外はコマを持たない。"""
    hours = [datetime(2026, 11, 24, hour) for hour in (10, 11, 12)]
    start = datetime(2026, 11, 24, 10, tzinfo=JST)

    frames = wind_frames(hours, "v1", start, start + timedelta(hours=49))

    assert [(frame.start.strftime("%H:%M"), frame.end.strftime("%H:%M"), frame.key) for frame in frames] == [
        ("10:00", "10:30", "v1-2026112410"), ("10:30", "11:30", "v1-2026112411"), ("11:30", "12:30", "v1-2026112412")]


def test_a_key_outside_the_current_frames_is_refused():
    """終わったコマや、版の変わる前のコマの印は、画面が一覧を読み直してから求め直す。"""
    frames = wind_frames([datetime(2026, 11, 24, 10)], "v2", DAY, DAY + timedelta(days=1))

    assert frame_start(frames, "v2-2026112410") == datetime(2026, 11, 24, 9, 30, tzinfo=JST)
    with pytest.raises(StaleTimeFrameError):
        frame_start(frames, "v1-2026112410")
