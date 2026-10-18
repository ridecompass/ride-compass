"""`infrastructure/rate_limiter.py`——接続元ごとの移動窓の回数制限（`check_rate_limit`）。

時計は`tests/conftest.py: monotonic_clock`（回数制限が読む時計。テストごとに1窓進んでから始まる）で進める。
接続元の鍵はテストごとに別の名前にし、前のテストの記録と混ざらないようにする。

ここで見ないもの:
- 上限を超えた要求が429になること・上限の値と鍵の接頭辞 → `api/rate_limit.py`を通る各ルーターのテスト
  （例: `test_region_routes.py`）
- 件数の上限（`_MAX_CLIENTS`）を超えたときに最も古い接続元を忘れること。10万の接続元を作らないと届かず、
  忘れられた接続元が少し多く通るだけで利用者には見えない
"""

from app.infrastructure.rate_limiter import WINDOW_SECONDS, check_rate_limit


def test_a_request_leaves_the_count_once_it_is_a_full_window_old(monotonic_clock):
    """拒んだ回は数えない。数えると、連打をやめない接続元は窓が明けても回復しない。"""
    assert check_rate_limit("client-boundary", 1)

    monotonic_clock.advance(WINDOW_SECONDS - 1)
    assert not check_rate_limit("client-boundary", 1)

    monotonic_clock.advance(1)
    assert check_rate_limit("client-boundary", 1)
