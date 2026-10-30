"""計測中に、DBとPython側で何が起きていたかを同じ実行から記録する。

所要時間だけでは「何が律速か」が分からない。壁時計が延びたとき、Python側がCPUを
使い切っているのか、DBの応答を待っているのか、どちらでもなく取り合っているのかで
打ち手が変わる。そして遅いのがDBなら、**どのクエリが**どんな**実行計画で**動いて
いたのかまで無いと、次の一手が決まらない。ここで全部取る。

psutilもpg_stat_statementsも使わない（依存と設定を増やさない）。自プロセスは
`time.process_time`と`resource.getrusage`、DB側は`pg_stat_activity`の標本から見る:

- **待ち事象が無い`active`**は、そのバックエンドがCPUを回していることを意味する
- **同じクエリが標本に現れた回数**は、そのクエリが占めた時間に比例する
- 実行計画は`EXPLAIN (GENERIC_PLAN)`で取る。値を束ねずに計画を出せるので、
  アプリが投げた文をそのまま渡せる

標本のクエリ文はPostgreSQLの設定（track_activity_query_size、既定1024バイト）で切られる。切られた文は
計画を取れないので、占めた割合だけを出して計画は空にする——推測で埋めない。

**OSが持たない値は「測れない」と出す。** Windowsには`resource`も`os.getloadavg`も無く、
RSSとloadは`None`になる（0で埋めると、測った0と見分けが付かない）。

RSSは`ru_maxrss`で、**プロセスが始まってからの最大**であり回ごとの値ではない（同じプロセスで
冷えた回の後に回した温まった回にも、冷えた回の最大が出る）。名前もそう名乗る。
"""

import asyncio
import contextlib
import os
import re
import time
from collections import Counter
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import asyncpg

#: 標本を取る間隔（秒）。細かくするほど計測自体が対象へ割り込む。
DEFAULT_INTERVAL_SECONDS = 0.5

#: 実行計画まで取るクエリの数（占めた割合の大きい順）。
DEFAULT_PLAN_LIMIT = 3

_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class Sample:
    app_cpu_seconds: float
    process_peak_rss_mb: float | None
    load1: float | None
    db_on_cpu: int


@dataclass(frozen=True)
class QueryShare:
    """標本に現れた割合と、その文の実行計画。"""

    share: float
    samples: int
    query: str
    plan: str

    @property
    def head(self) -> str:
        return self.query[:110]


@dataclass
class ResourceTrace:
    samples: list[Sample] = field(default_factory=list)
    queries: Counter = field(default_factory=Counter)
    wall_seconds: float = 0.0
    query_plans: list[QueryShare] = field(default_factory=list)

    @property
    def app_cpu_seconds(self) -> float:
        if len(self.samples) < 2:
            return 0.0
        return self.samples[-1].app_cpu_seconds - self.samples[0].app_cpu_seconds

    @property
    def app_cpu_ratio(self) -> float:
        """壁時計に対してPython側がCPUを回していた割合。1.0で1コアぶん使い切り。"""
        return self.app_cpu_seconds / self.wall_seconds if self.wall_seconds else 0.0

    @property
    def process_peak_rss_mb(self) -> float | None:
        return max((s.process_peak_rss_mb for s in self.samples if s.process_peak_rss_mb is not None), default=None)

    @property
    def db_cpu_ratio(self) -> float:
        """標本のうち、DBのバックエンドが待ち事象なしで動いていた割合。"""
        if not self.samples:
            return 0.0
        return sum(1 for s in self.samples if s.db_on_cpu > 0) / len(self.samples)

    @property
    def peak_load1(self) -> float | None:
        return max((s.load1 for s in self.samples if s.load1 is not None), default=None)

    def as_dict(self) -> dict[str, object]:
        return {
            "wall_seconds": round(self.wall_seconds, 2),
            "app_cpu_seconds": round(self.app_cpu_seconds, 2),
            "app_cpu_ratio": round(self.app_cpu_ratio, 3),
            "db_cpu_ratio": round(self.db_cpu_ratio, 3),
            "process_peak_rss_mb": _rounded(self.process_peak_rss_mb, 1),
            "peak_load1": _rounded(self.peak_load1, 2),
            "sample_count": len(self.samples),
            "queries": [
                {"share": q.share, "samples": q.samples, "query": q.query, "plan": q.plan}
                for q in self.query_plans
            ],
        }

    def summary(self) -> str:
        return (
            f"壁時計 {self.wall_seconds:7.1f}秒 / "
            f"Python側CPU {self.app_cpu_seconds:6.1f}秒（{self.app_cpu_ratio:.2f}コア相当） / "
            f"DBがCPUを回していた標本 {self.db_cpu_ratio * 100:5.1f}% / "
            f"RSS（プロセス開始からの最大） {_shown(self.process_peak_rss_mb, '6.0f', 'MB')} / "
            f"load最大 {_shown(self.peak_load1, '.2f')}"
        )

    def query_lines(self) -> list[str]:
        lines: list[str] = []
        for q in self.query_plans:
            lines.append(f"    {q.share * 100:5.1f}%（標本{q.samples}）{q.head}")
            for plan_line in q.plan.splitlines():
                lines.append(f"        {plan_line}")
            if not q.plan:
                lines.append("        （文が途中で切られているため計画を取れない）")
        return lines


def _rounded(value: float | None, digits: int) -> float | None:
    return None if value is None else round(value, digits)


def _shown(value: float | None, spec: str, unit: str = "") -> str:
    return "測れない" if value is None else f"{value:{spec}}{unit}"


def _load1() -> float | None:
    if not hasattr(os, "getloadavg"):  # Windowsには無い
        return None
    try:
        return os.getloadavg()[0]
    except OSError:
        return None


def _process_peak_rss_mb() -> float | None:
    try:
        import resource  # Windowsには無いので、モジュールの読み込みを止めないよう使う所で読む
    except ImportError:
        return None
    # Linuxの`ru_maxrss`はキロバイト。
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


_ACTIVITY_SQL = """
SELECT wait_event, query
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
"""


async def _explain(connection: asyncpg.Connection, query: str) -> str:
    """値を束ねずに計画を取る。取れない文（切られた文・ユーティリティ文）は空を返す。

    **クライアントに解釈させない。** アプリが投げる文は`$1`を含み、そのまま渡すと
    asyncpgが引数を要求してエラーになる。`EXPLAIN (GENERIC_PLAN)`は
    プレースホルダのまま計画を出せるので、サーバ側で組み立てて実行する。

    計測の失敗で計測対象の結果まで失わないよう、ここでの例外はすべて空文字にする。
    """
    try:
        return await connection.fetchval("SELECT pg_temp._rc_explain($1::text)", query)
    except Exception:  # 計測の失敗で計測対象を巻き込まない
        return ""


#: 文字列として受け取った文の計画を返すヘルパ。`EXPLAIN`は動的に組み立てられないため、
#: サーバ側の関数で包む（計測用の一時関数で、計測が終われば落とす）。
_EXPLAIN_HELPER_SQL = """
CREATE OR REPLACE FUNCTION pg_temp._rc_explain(sql text) RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE line text; out text := '';
BEGIN
    FOR line IN EXECUTE 'EXPLAIN (GENERIC_PLAN) ' || sql LOOP
        out := out || line || chr(10);
    END LOOP;
    RETURN rtrim(out, chr(10));
EXCEPTION WHEN OTHERS THEN RETURN '';
END
$fn$
"""



@contextlib.asynccontextmanager
async def sample_resources(
    asyncpg_dsn: str,
    interval: float = DEFAULT_INTERVAL_SECONDS,
    plan_limit: int = DEFAULT_PLAN_LIMIT,
) -> AsyncIterator[ResourceTrace]:
    """囲んだ区間の資源の使われ方・DBが回していたクエリ・その実行計画を記録する。

    DBの標本は計測専用の接続から取る——計測対象の接続を借りると、計測自体が対象の
    待ち行列へ並んでしまう。標本は間隔ごとのほかに区間の始まりと終わりで1つずつ取る
    （間隔ごとだけでは、区間の両端の間隔が標本に現れず、短い区間ほど割合とCPU時間がずれる）。
    """
    trace = ResourceTrace()
    connection = await asyncpg.connect(asyncpg_dsn)
    await connection.execute(_EXPLAIN_HELPER_SQL)
    stop = asyncio.Event()

    async def take_sample() -> None:
        try:
            rows = await connection.fetch(_ACTIVITY_SQL)
        except (asyncpg.PostgresError, OSError):
            rows = []
        on_cpu = sum(1 for r in rows if r["wait_event"] is None)
        for row in rows:
            text = _WHITESPACE.sub(" ", (row["query"] or "")).strip()
            if text:
                trace.queries[text] += 1
        trace.samples.append(Sample(
            app_cpu_seconds=time.process_time(),
            process_peak_rss_mb=_process_peak_rss_mb(),
            load1=_load1(),
            db_on_cpu=on_cpu,
        ))

    async def loop() -> None:
        while True:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=interval)
            if stop.is_set():
                return
            await take_sample()

    await take_sample()
    started = time.perf_counter()
    task = asyncio.create_task(loop())
    try:
        yield trace
    finally:
        trace.wall_seconds = time.perf_counter() - started
        stop.set()
        await task
        await take_sample()
        total = sum(trace.queries.values())
        for text, count in trace.queries.most_common(plan_limit):
            trace.query_plans.append(QueryShare(
                share=count / total if total else 0.0,
                samples=count,
                query=text,
                plan=await _explain(connection, text),
            ))
        await connection.close()
