"""`domain/time_zone.py`——応答へ書くタイムゾーンの無い時刻（`jst_local_text`）。

ここで見ないもの:
- 画面が同じ形を日本時間として読むこと → 生成物`time-expectations.json`を通す画面のテスト（`lib/time.test.ts`）
- 予報の系列の時刻への寄せ方（`as_series_time`）を使う読み手 → `test_wind_way_service.py`
"""

from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.domain.time_zone import JST, jst_local_text


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (datetime(2026, 8, 31, 0, 5, 59), "2026-08-31T00:05"),  # タイムゾーンが無ければJSTの時刻として読み、秒を落とす
        (datetime(2026, 8, 30, 15, 0, tzinfo=UTC), "2026-08-31T00:00"),  # 協定世界時はJSTへ直し、日付も変わる
        (datetime(2026, 8, 31, 0, 0, tzinfo=JST), "2026-08-31T00:00"),
        (datetime(2026, 8, 31, 0, 0, tzinfo=timezone(timedelta(hours=-5))), "2026-08-31T14:00"),
    ],
)
def test_jst_local_text(value: datetime, expected: str) -> None:
    assert jst_local_text(value) == expected
