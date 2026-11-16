"""`backend/scripts/prod_place_search_check.py`のテスト（本番・ネットワークには触れない）。

引いた語の結果ごとに、壊れとして知らせるかを見る。
ここで見ないもの: 本番へ要求を送る口（`search`・`main`）とワークフローから呼ぶ所の結線。
"""

import pytest

from scripts import prod_place_search_check as check

LIMIT = check.SEARCH_LIMIT_SECONDS
OVER = f"{LIMIT:.0f}秒の上限を超えた"


@pytest.mark.parametrize(
    ("seconds", "status", "candidates", "reasons"),
    [
        (LIMIT, 200, 20, None),
        (LIMIT + 0.1, 200, 20, OVER),
        # 代表の語はどれも本番で候補が当たる語なので、0件は引き方か表の壊れ。
        (0.5, 200, 0, "候補が無い"),
        (0.5, 502, 0, "200で返らない（502）"),
        (30.0, "TimeoutError('timed out')", 0, f"200で返らない（TimeoutError('timed out')）・{OVER}"),
    ],
)
def test_reports_searches_that_users_would_see_broken(seconds, status, candidates, reasons):
    result = check.Searched("銭湯", seconds, status, candidates)

    expected = [] if reasons is None else [f"{result.describe()}: {reasons}"]
    assert check.problems([result]) == expected
