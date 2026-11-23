"""`infrastructure/debug_log.py`——外部I/Oの記録（`log_external_call`・`mark_failed`）、429の記録
（`record_rate_limit_rejection`）と、それらの集計（`get_stats`）と、区切りごとの1行（`log_window_summary`）。

集計はプロセスの寿命の間残るので、テストごとに別のカテゴリ（`cat`）で数える。経過の時間は
`monotonic_clock`で、失敗の時刻は`clock`で進める。
ログは`caplog`で読む。

ここで見ないもの:
- 集計が`/api/debug/stats`の応答へどう出るか → `test_debug_stats_route.py`
- どの呼び出し元がどのカテゴリ・cache・resultを書くか → 呼び出し元のテスト（例: `test_simple_api_client.py`）
"""

import logging

import httpx
import pytest

from app.infrastructure.debug_log import (
    LATENCY_BUCKET_UPPER_MS,
    get_stats,
    log_external_call,
    log_window_summary,
    mark_failed,
    record_rate_limit_rejection,
)

FROZEN_AT = "2026-01-01T00:00:00+00:00"


@pytest.fixture
def cat(request) -> str:
    """このテストだけのカテゴリ。前のテストの数と混ざらない名前で始める。"""
    return f"cat:{request.node.name}"


@pytest.fixture
def logs(caplog):
    caplog.set_level(logging.DEBUG, logger="ridecompass.external")
    return caplog


def warnings_of(logs) -> list[str]:
    return [record.getMessage() for record in logs.records if record.levelno == logging.WARNING]


def http_error(status_code: int) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", "https://example.test/tile?lat=35.681236&lon=139.767125")
    return httpx.HTTPStatusError("failed", request=request, response=httpx.Response(status_code, request=request))


def call(category: str, elapsed_seconds: float = 0.0, monotonic_clock=None, **result: object) -> None:
    """`category`の呼び出しを1回記録する。`result`は呼び出し元が書き足す結果。"""
    with log_external_call(category) as fields:
        if monotonic_clock is not None:
            monotonic_clock.advance(elapsed_seconds)
        fields.update(result)


class TestCounting:
    def test_a_successful_call_is_counted_with_its_time(self, cat, monotonic_clock):
        call(cat, 0.1, monotonic_clock)
        call(cat, 0.3, monotonic_clock)

        stats = get_stats().external[cat]
        assert (stats.calls, stats.errors) == (2, 0)
        assert (stats.total_ms, stats.max_ms, stats.avg_ms) == (400, 300, 200)
        assert stats.last_error is None

    @pytest.mark.parametrize(
        ("caches", "counted"),
        [(("hit", "hit", "miss"), (2, 1, 0.667)), ((None,), (0, 0, None))],
    )
    def test_the_hit_rate_is_over_the_calls_that_looked_at_a_cache(self, cat, caches, counted):
        for cache in caches:
            call(cat, cache=cache)

        stats = get_stats().external[cat]
        assert (stats.cache_hits, stats.cache_misses, stats.cache_hit_rate) == counted


class TestFailures:

    def test_a_failure_caught_by_the_caller_is_counted_and_warned_with_the_exception(self, cat, logs):
        with log_external_call(cat, tile="14/1/2") as fields:
            mark_failed(fields, http_error(503))

        stats = get_stats().external[cat]
        assert (stats.errors, stats.error_types) == (1, {"http_503": 1})
        [warning] = warnings_of(logs)
        assert "failed after" in warning
        assert "14/1/2" in warning
        assert "HTTPStatusError" in warning

    def test_a_result_marked_as_error_without_a_reason_is_counted_as_unknown(self, cat, logs):
        call(cat, result="error")

        assert get_stats().external[cat].error_types == {"unknown": 1}
        assert len(warnings_of(logs)) == 1

    def test_a_later_success_keeps_the_last_error(self, cat, clock):
        call(cat, result="error")
        clock.tick(60)
        call(cat)

        assert get_stats().external[cat].last_error.at == FROZEN_AT


class TestLogLines:
    def test_a_warning_rounds_every_coordinate_to_two_decimals(self, cat, logs):
        """WARNINGは常時出るので、利用者の現在地を1km程度より細かく残さない。"""
        with log_external_call(
            cat, lat=35.681236, bbox=(139.767125, 35.681236), points=[139.767125], area={"lat": 35.681236}
        ) as fields:
            fields["result"] = "error"

        [warning] = warnings_of(logs)
        assert "35.681236" not in warning
        assert "139.767125" not in warning
        assert "'lat': 35.68" in warning
        assert "(139.77, 35.68)" in warning
        assert "[139.77]" in warning
        assert "{'lat': 35.68}" in warning


class TestRateLimitRejections:
    def test_rejections_are_counted_per_category_and_warned_with_the_client_and_limit(self, cat, logs):
        tiles, generate = f"{cat}/tiles", f"{cat}/generate"
        record_rate_limit_rejection(tiles, "203.0.113.5", "120/min")
        record_rate_limit_rejection(tiles, "203.0.113.5", "120/min")
        record_rate_limit_rejection(generate, "203.0.113.6", "concurrent=2")

        rejections = get_stats().rate_limit_rejections
        assert (rejections[tiles], rejections[generate]) == (2, 1)
        assert warnings_of(logs)[0] == f"[ratelimit:{tiles}] rejected client=203.0.113.5 limit=120/min"


def summary_of(logs, category: str) -> list[str]:
    return [record.getMessage() for record in logs.records
            if record.levelno == logging.INFO and record.getMessage().startswith(f"[summary:{category}] ")]


class TestWindowSummary:
    """区切りの1行は、本番のログだけで地図のタイル等の応答の速さとその前後の変化を読むためのもの。"""

    @pytest.fixture
    def window(self, logs, monotonic_clock):
        """前のテストの記録を区切りの外へ出してから、テストの記録を数える。"""
        log_window_summary()
        logs.clear()
        return monotonic_clock

    def test_a_window_gives_counts_hit_rate_and_latency_per_cache_result(self, cat, logs, window):
        for ms in range(1, 11):
            call(cat, ms / 1000, window, cache="hit")
        call(cat, 0.208, window, cache="miss")
        call(cat, 0.3, window, cache="miss", result="error")
        window.advance(600 - 0.563)  # 区切りは記録の所要（0.563秒）と合わせて600秒

        log_window_summary()

        assert summary_of(logs, cat) == [
            f"[summary:{cat}] window_s=600 calls=12 errors=1 hit_rate=0.833 "
            "hit_ms=n:10,p50:5,p90:9,max:10 miss_ms=n:2,p50:208,p90:300,max:300"
        ]

    def test_a_category_without_a_cache_has_no_hit_rate(self, cat, logs, window):
        call(cat, 0.04, window)

        log_window_summary()

        assert summary_of(logs, cat) == [f"[summary:{cat}] window_s=0 calls=1 errors=0 hit_rate=- nocache_ms=n:1,p50:40,p90:40,max:40"]

    @pytest.mark.parametrize(
        ("ms", "p50"),
        # 中央値は遅い方の値に引かれない1件目で、刻みの上端ちょうどならその刻み、1つ越えると次の刻みの上端。
        # 最後の刻みより遅い値は、刻みの上端の代わりに区切りの最大の値で出る。
        [([LATENCY_BUCKET_UPPER_MS[20], 1000], LATENCY_BUCKET_UPPER_MS[20]),
         ([LATENCY_BUCKET_UPPER_MS[20] + 1, 1000], LATENCY_BUCKET_UPPER_MS[21]),
         ([LATENCY_BUCKET_UPPER_MS[-1] + 5000, LATENCY_BUCKET_UPPER_MS[-1] + 6000], LATENCY_BUCKET_UPPER_MS[-1] + 6000)],
    )
    def test_a_quantile_is_the_upper_end_of_its_bucket(self, cat, logs, window, ms, p50):
        for each in ms:
            call(cat, each / 1000, window)

        log_window_summary()

        assert f",p50:{p50}," in summary_of(logs, cat)[0]

    def test_the_next_window_starts_empty(self, cat, logs, window):
        call(cat)
        log_window_summary()
        logs.clear()

        log_window_summary()

        assert summary_of(logs, cat) == []
