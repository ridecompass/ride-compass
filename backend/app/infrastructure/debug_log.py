"""外部I/O(外部API・タイル/標高キャッシュ)イベントのログと集計
（ログレベルの方針は .claude/rules/logging.md）。

失敗はdebug_modeに関わらず常時WARNINGで出す。集計はプロセス内カウンタに持ち、`/api/debug/stats`が読む。
同じ記録を区切りごとにも集め、`log_window_summary`が区切りの間の分をカテゴリごとに1行のINFOで出す。
"""

import logging
import math
import threading
from bisect import bisect_left
from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime

from pydantic import Field

from app.domain.stopwatch import elapsed_ms, start_timer
from app.domain.strict_model import StrictModel

logger = logging.getLogger("ridecompass.external")

# 常時出力されるWARNINGにはユーザーの現在地由来の座標が含まれうるため、float値は
# 小数2桁(≈1km)へ丸めて出す。DEBUG(debug_mode時のみ)は調査精度を優先しそのまま出す。
_ALWAYS_ON_FLOAT_PRECISION = 2


class LastError(StrictModel):
    """最後の失敗。種類と時刻は失敗のたびに一緒に書かれる。"""

    type: str
    at: str


class ExternalCallStats(StrictModel):
    """カテゴリ1つぶんの集計。プロセス内のカウンタそのものであり、`/api/debug/stats`の応答の形でもある。"""

    calls: int
    errors: int
    # ヒット率・平均の計算元。応答には載せない（画面は率と平均を読む）。
    cache_hits: int = Field(exclude=True)
    cache_misses: int = Field(exclude=True)
    total_ms: int = Field(exclude=True)
    max_ms: int
    avg_ms: int
    cache_hit_rate: float | None
    # 失敗の主な理由を推測するための追加集計。error_typesは
    # HTTPステータス（"http_429"）か例外クラス名のみの粗いラベルで、メッセージ本文・座標は含まない。
    error_types: dict[str, int]
    last_error: LastError | None


class StatsSnapshot(StrictModel):
    """`get_stats`が返すプロセス内集計の写し。"""

    external: dict[str, ExternalCallStats]
    # カテゴリ → 429拒否数（`record_rate_limit_rejection`）。
    rate_limit_rejections: dict[str, int]


def _empty_stats() -> ExternalCallStats:
    return ExternalCallStats(
        calls=0,
        errors=0,
        cache_hits=0,
        cache_misses=0,
        total_ms=0,
        max_ms=0,
        avg_ms=0,
        cache_hit_rate=None,
        error_types={},
        last_error=None,
    )


_lock = threading.Lock()
_external_stats: defaultdict[str, ExternalCallStats] = defaultdict(_empty_stats)
_rate_limit_rejections: defaultdict[str, int] = defaultdict(int)

# 区切りの所要の分布の刻みの上端（ミリ秒）。区切りの中の値を全部持たずに分位点を出すため、度数だけを持つ。
# 隣の刻みとの比が1.1なので、分位点は刻みの上端で、真の値より最大で1割大きく出る。最後の刻みより遅い値は最大の値で表す。
LATENCY_BUCKET_UPPER_MS: tuple[int, ...] = tuple(sorted({math.ceil(1.1**k) for k in range(121)}))


class _LatencyHistogram:
    def __init__(self) -> None:
        self.counts = [0] * (len(LATENCY_BUCKET_UPPER_MS) + 1)
        self.n = 0
        self.max_ms = 0

    def add(self, ms: int) -> None:
        self.counts[bisect_left(LATENCY_BUCKET_UPPER_MS, ms)] += 1
        self.n += 1
        self.max_ms = max(self.max_ms, ms)

    def quantile_ms(self, q: float) -> int:
        """`q`分位点を含む刻みの上端（最大の値を超えない）。"""
        rank = max(1, math.ceil(q * self.n))
        seen = 0
        for index, count in enumerate(self.counts):
            seen += count
            if seen >= rank:
                break
        upper = LATENCY_BUCKET_UPPER_MS[index] if index < len(LATENCY_BUCKET_UPPER_MS) else self.max_ms
        return min(upper, self.max_ms)

    def note(self) -> str:
        return f"n:{self.n},p50:{self.quantile_ms(0.5)},p90:{self.quantile_ms(0.9)},max:{self.max_ms}"


class _WindowStats:
    """カテゴリ1つの、1区切りの間の集計。所要は持ちに当たった・当たらなかった・持ちを見ない要求で分ける。"""

    def __init__(self) -> None:
        self.calls = 0
        self.errors = 0
        self.latency: dict[str, _LatencyHistogram] = defaultdict(_LatencyHistogram)

    def note(self) -> str:
        hits, misses = (self.latency[group].n if group in self.latency else 0 for group in ("hit", "miss"))
        hit_rate = f"{hits / (hits + misses):.3f}" if hits + misses else "-"
        groups = " ".join(f"{group}_ms={self.latency[group].note()}"
                          for group in ("hit", "miss", "nocache") if group in self.latency)
        return f"calls={self.calls} errors={self.errors} hit_rate={hit_rate} {groups}"


_window: defaultdict[str, _WindowStats] = defaultdict(_WindowStats)
_window_started = start_timer()


def error_type_label(exc: BaseException) -> str:
    """例外を`/api/debug/stats`へ出しても安全な粗いラベルへ変換する。

    例外メッセージ・URL（クエリパラメータに座標が乗りうる）は含めず、クラス名と
    （httpxのHTTPStatusErrorなら）HTTPステータスコードのみを使う。
    """
    status_code = getattr(getattr(exc, "response", None), "status_code", None)
    if status_code is not None:
        return f"http_{status_code}"
    return type(exc).__name__


def _round_floats(value: object) -> object:
    """WARNINGログ用にfloat(座標等)を丸める。tuple/list/dictは再帰的に処理する。"""
    if isinstance(value, float):
        return round(value, _ALWAYS_ON_FLOAT_PRECISION)
    if isinstance(value, (list, tuple)):
        return type(value)(_round_floats(v) for v in value)
    if isinstance(value, dict):
        return {k: _round_floats(v) for k, v in value.items()}
    return value


def _record(category: str, elapsed_ms: int, fields: dict, error: bool) -> None:
    with _lock:
        stats = _external_stats[category]
        stats.calls += 1
        if error:
            stats.errors += 1
            error_type = fields.get("error_type") or "unknown"
            stats.error_types[error_type] = stats.error_types.get(error_type, 0) + 1
            stats.last_error = LastError(type=error_type, at=datetime.now(UTC).isoformat())
        cache = fields.get("cache")
        if cache == "hit":
            stats.cache_hits += 1
        elif cache == "miss":
            stats.cache_misses += 1
        stats.total_ms += elapsed_ms
        stats.max_ms = max(stats.max_ms, elapsed_ms)
        stats.avg_ms = round(stats.total_ms / stats.calls)
        lookups = stats.cache_hits + stats.cache_misses
        stats.cache_hit_rate = round(stats.cache_hits / lookups, 3) if lookups else None
        window = _window[category]
        window.calls += 1
        window.errors += int(error)
        window.latency[cache if cache in ("hit", "miss") else "nocache"].add(elapsed_ms)


def mark_failed(fields: dict, exc: BaseException) -> None:
    """`log_external_call`の中で例外を捕まえて既定値へ倒すときの、失敗の記録の入口。

    `log_external_call`を抜けるとき、結果が失敗としてカテゴリの集計（`error_types`）へ入り、
    WARNINGが`fields`（対象のタイル・ID等）と例外を添えて出る。
    """
    fields["result"] = "error"
    fields["error"] = repr(exc)
    fields["error_type"] = error_type_label(exc)


def record_rate_limit_rejection(category: str, client_id: str, limit: str) -> None:
    """429拒否を集計しつつ、WARNINGで常時記録する。limitは"120/min"・"concurrent=2"のような人間可読の上限表記。"""
    with _lock:
        _rate_limit_rejections[category] += 1
    logger.warning("[ratelimit:%s] rejected client=%s limit=%s", category, client_id, limit)


def get_stats() -> StatsSnapshot:
    """/api/debug/stats用のプロセス内集計の写し。応答はロックの外で組み立てるため、
    実行中のカウンタと共有しない複製を返す。"""
    with _lock:
        return StatsSnapshot(
            external={category: stats.model_copy(deep=True) for category, stats in sorted(_external_stats.items())},
            rate_limit_rejections=dict(_rate_limit_rejections),
        )


def log_window_summary() -> None:
    """前に呼んでから今までの区切りの集計を、カテゴリごとに1行のINFOで出して空にする。呼んだ間に記録の無いカテゴリは出さない。"""
    global _window, _window_started
    with _lock:
        window, _window = _window, defaultdict(_WindowStats)
        window_s = round(elapsed_ms(_window_started) / 1000)
        _window_started = start_timer()
    for category, stats in sorted(window.items()):
        logger.info("[summary:%s] window_s=%d %s", category, window_s, stats.note())


@contextmanager
def log_external_call(category: str, **fields: object) -> Iterator[dict]:
    """外部API呼び出し・キャッシュアクセスをカテゴリ単位でログ・集計する。

    `fields`はログ用の付帯情報(座標・パス等)。呼び出し元は`yield`されたdictに
    結果情報(cache="hit"/"miss", result="error", status等)を追記してから抜けると、
    完了ログと統計にそれも反映される。失敗(例外、またはresult=="error")はWARNING、成功はDEBUGで出す。
    """
    started = start_timer()
    logger.debug("[%s] start %s", category, fields)
    try:
        yield fields
    except Exception as exc:
        took_ms = elapsed_ms(started)
        fields["error_type"] = error_type_label(exc)
        _record(category, took_ms, fields, error=True)
        logger.warning("[%s] error after %dms %s error=%r", category, took_ms, _round_floats(fields), exc)
        raise
    else:
        took_ms = elapsed_ms(started)
        error = fields.get("result") == "error"
        _record(category, took_ms, fields, error=error)
        if error:
            logger.warning("[%s] failed after %dms %s", category, took_ms, _round_floats(fields))
        else:
            logger.debug("[%s] done in %dms %s", category, took_ms, fields)
