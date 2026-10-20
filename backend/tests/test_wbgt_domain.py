"""`domain/wbgt.py`——暑さ指数の警戒の段・提供期間・今の予測の選び方。

入口は`wbgt_level`（値→段と呼び名）・`provision_period`と`is_within_provision_period`（値が無いのを正常とみなす日か）・
`current_forecast`（取得した予測から今の1件を選ぶ）。

ここで見ないもの:
- 配信元の応答を`WbgtForecast`へ解くこと・発表時刻の無い行を載せないこと → `test_wbgt_client.py`
- 最寄りの地点の選び方・値が得られないときに提供期間で空と未取得を分けること → `test_wbgt_service.py`
- 段階ごとの呼び名`WBGT_LEVEL_LABELS`——段と同じ並びから導き、全段がそろっていることは
  `domain/warning_display.py`がimportの時点で全段を引いて確かめる
"""

from datetime import date, datetime, timedelta, timezone

import pytest

from app.domain.wbgt import WbgtForecast, current_forecast, is_within_provision_period, provision_period, wbgt_level

JST = timezone(timedelta(hours=9))


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (20.9, None),
        (21.0, ("advisory", "注意")),
        (24.9, ("advisory", "注意")),
        (25.0, ("warning", "警戒")),
        (27.9, ("warning", "警戒")),
        (28.0, ("severe_warning", "厳重警戒")),
        (30.9, ("severe_warning", "厳重警戒")),
        (31.0, ("emergency_warning", "危険")),
    ],
)
def test_the_level_follows_the_exercise_guideline_thresholds(value, expected):
    """熱中症予防運動指針の区分（21・25・28・31以上）。21未満の「ほぼ安全」はバッジを出さない。"""
    assert wbgt_level(value) == expected


@pytest.mark.parametrize(
    ("year", "expected"),
    [
        (2026, (date(2026, 4, 22), date(2026, 10, 21))),  # 4月1日が水曜
        (2027, (date(2027, 4, 28), date(2027, 10, 27))),  # 4月1日が木曜（第1水曜が最も遅い）
    ],
)
def test_the_period_runs_from_the_fourth_april_wednesday_for_26_weeks(year, expected):
    assert provision_period(year) == expected


@pytest.mark.parametrize(
    ("at", "within"),
    [
        (datetime(2026, 4, 21, 23, 59, tzinfo=JST), False),
        (datetime(2026, 4, 22, 0, 0, tzinfo=JST), True),
        (datetime(2026, 10, 21, 23, 59, tzinfo=JST), True),
        (datetime(2026, 10, 22, 0, 0, tzinfo=JST), False),
    ],
)
def test_both_the_first_and_the_last_day_are_within_the_period(at, within):
    assert is_within_provision_period(at) is within


def _forecast(reference_time: str, forecast_time: datetime | None, wbgt: float | None = 26.0) -> WbgtForecast:
    return WbgtForecast(
        reference_time=reference_time,
        forecast_time=forecast_time,
        wbgt=wbgt,
    )


NOW = datetime(2026, 7, 1, 13, 20, tzinfo=JST)


def test_the_forecast_nearest_to_now_is_selected_whether_before_or_after():
    """今はタイムゾーンを持つ（JSTとは限らない）が、対象時刻はJSTの素の時刻。比べる前に揃える。"""
    before = _forecast("2026070112", datetime(2026, 7, 1, 13, 0))
    after = _forecast("2026070112", datetime(2026, 7, 1, 14, 0))
    far = _forecast("2026070112", datetime(2026, 7, 1, 18, 0))
    assert current_forecast([after, before, far], NOW) is before

    later_now = datetime(2026, 7, 1, 13, 40, tzinfo=JST)
    assert current_forecast([before, after], later_now) is after
    assert current_forecast([before, after], later_now.astimezone(timezone.utc)) is after


def test_a_forecast_without_a_readable_target_time_is_never_selected():
    unreadable = _forecast("2026070112", None)
    readable = _forecast("2026070112", datetime(2026, 7, 1, 18, 0))
    assert current_forecast([unreadable, readable], NOW) is readable


def test_a_latest_issue_with_no_readable_target_time_does_not_fall_back_to_an_older_issue():
    """読めない行も発表回を決めるのには数える。古い発表回の値は、新しい発表回で既に置き換わっている。"""
    older = _forecast("2026070109", datetime(2026, 7, 1, 13, 0))
    latest_unreadable = _forecast("2026070112", None)
    assert current_forecast([older, latest_unreadable], NOW) is None
