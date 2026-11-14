"""複数のバッチが同じ形で必要とするものを集める。

特定のバッチだけが使うものは、そのバッチが持つ。
"""

import argparse
import asyncio
import logging
import time
from collections.abc import AsyncIterator, Callable, Coroutine
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, TypeVar

import httpx
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.config import settings

_T = TypeVar("_T")


@asynccontextmanager
async def batch_session_factory(
    database_url: str | None, *, schema: str | None = None,
) -> AsyncIterator[async_sessionmaker]:
    """バッチ用のセッションファクトリを作り、終了時にエンジンを必ず破棄する。

    バッチはリクエスト経路と違い自前でエンジンを持つ。`infrastructure/database.py`の
    共有セッションファクトリはアプリ稼働中の接続プールを前提にしており、単発実行の
    バッチが使うとプロセス終了時に破棄されない接続が残る。

    `expire_on_commit=False`はバッチ共通の前提——commit後もORMオブジェクトの属性へ
    触れる（件数集計・ログ出力）ため。

    `schema`を渡すと、表の名前をそのスキーマから先に探す（無ければ`public`）。
    """
    connect_args = {"server_settings": {"search_path": f"{schema}, public"}} if schema else {}
    engine = create_async_engine(database_url or settings.database_url, connect_args=connect_args)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


def configure_cli_logging() -> None:
    """バッチと取得の道具が端末へ出すログの書式。"""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")


def run_batch_cli(
    parser: argparse.ArgumentParser,
    start: Callable[[argparse.Namespace, str], Coroutine[Any, Any, int]],
) -> int:
    """DBを書くバッチの入口の骨格。ログを整え、引数を読み、本体を流す。

    `--database-url`はここで足す（省けば設定値）。`start`は読んだ引数とDBのURLを受けて
    本体のコルーチンを返す。イベントループの外で呼ぶので、引数の検査（`parser.error`）は
    `start`の中に置いてよい。
    """
    configure_cli_logging()
    parser.add_argument("--database-url", default=None)
    args = parser.parse_args()
    return asyncio.run(start(args, args.database_url or settings.database_url))


def affected_rows(status: str) -> int:
    """asyncpgの`execute`が返す状態の文字列（`INSERT 0 123`・`UPDATE 45`等）から、書いた行の数を読む。"""
    return int(status.split()[-1])


def asyncpg_dsn(sqlalchemy_url: str) -> str:
    """SQLAlchemy用URLを、asyncpg.connectが受け付けるDSNへ正規化する。

    `ssl=`クエリはSQLAlchemyのasyncpgダイアレクト固有の書き方で、asyncpgは解さない。
    libpq互換の`sslmode=`へ読み替える。
    """
    dsn = sqlalchemy_url.replace("+asyncpg", "")
    return dsn.replace("?ssl=", "?sslmode=").replace("&ssl=", "&sslmode=")



#: 取込と派生の作り直しが取るadvisory lockの名前（`hashtext`で鍵にする）。作り直しは排他で、取込は共有で
#: 取る——取込どうしは並んで走れ、取込と作り直しはどちらかが止まる。作り直しの段と段の間に取込が
#: 終わると、段ごとに違う取込を読み、記録した取込（`derived_source_runs`）とも食い違うため。
#: DBのバックアップ（`backend/ops/admin_data_backup.sh`）も書き出す間は排他で持ち、取込と作り直しの途中を書き出さない。
SOURCE_DATA_LOCK = "source_data"


#: 進捗を出す間隔（秒）。件数ごとに出すと、関東全域では行数が多すぎて読めない。
PROGRESS_INTERVAL_SECONDS = 15.0


def format_duration(seconds: float) -> str:
    minutes, second = divmod(int(seconds), 60)
    hour, minute = divmod(minutes, 60)
    return f"{hour}時間{minute:02d}分" if hour else f"{minute}分{second:02d}秒"


def format_progress(done: int, total: int | None, elapsed: float, unit: str = "件") -> str:
    """済んだ数・速さ・残りの見込み。

    `total`がNoneのとき（流しながら読むソースのように、全体数が終わるまで分からない
    とき）は残りを出さない——分からないものを推測で埋めると、読み手が当てにする。
    """
    rate = done / elapsed if elapsed > 0 else 0.0
    if total:
        remaining = (total - done) / rate if rate > 0 else 0.0
        return (f"{done:,}/{total:,}{unit}（{done / total * 100:.1f}%）"
                f" / 経過 {format_duration(elapsed)} / {rate:.1f}{unit}/秒"
                f" / 残り およそ {format_duration(remaining)}")
    return f"{done:,}{unit} / 経過 {format_duration(elapsed)} / {rate:.1f}{unit}/秒"


#: 取得途中の一時ファイルの印。所定の名前と紛れないもの。
FETCH_PART_SUFFIX = ".part"


def fetch_timeout(read_seconds: float) -> httpx.Timeout:
    """配布元から1つのファイルを取るときのタイムアウト。

    つなぐ・送る・接続の空きを待つ上限はどの配布元でも同じで、応答の途中で黙ってよい秒数（`read_seconds`）だけが
    配布元ごとに違う。
    """
    return httpx.Timeout(connect=10.0, read=read_seconds, write=30.0, pool=30.0)


def place_once(
    destination: Path,
    write: Callable[[Path], None],
    *,
    source: str,
    logger: logging.Logger,
) -> None:
    """配布元から取ったものを手元の所定の名前へ置く。何度実行しても安全で、終わる。

    - 手元にあるファイルは取り直さない
    - `write`に一時ファイルへ書かせてから所定の名前へ移す。途中で落ちた半端なものを「取得済み」に見せない

    中身は開いて確かめないので、配布元が200で返したエラーの本文も置かれ、読めないことはそれを読む取込が知らせる。
    `source`は取りに行く先で、ログにだけ使う。`write`の例外はそのまま呼び出し側へ出す。
    """
    if destination.exists():
        logger.info("既にある %s", destination)
        return
    logger.info("取りに行く %s", source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + FETCH_PART_SUFFIX)
    started = time.perf_counter()
    write(temporary)
    temporary.replace(destination)
    logger.info("取得した %s（%.1f MB / %s）", destination.name,
                destination.stat().st_size / (1024 * 1024), format_duration(time.perf_counter() - started))


def fetch_once(
    url: str,
    destination: Path,
    *,
    read_timeout: float,
    logger: logging.Logger,
) -> None:
    """配布元のURLのファイルを、`place_once`の手順で手元の所定の名前へ写す。

    `read_timeout`は`fetch_timeout`へ渡す。通信の失敗は例外のまま呼び出し側へ出す。
    """
    def write(temporary: Path) -> None:
        started = time.perf_counter()
        last_report = started
        written = 0
        with httpx.stream("GET", url, timeout=fetch_timeout(read_timeout), follow_redirects=True) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length") or 0) or None
            with temporary.open("wb") as sink:
                for chunk in response.iter_bytes():
                    sink.write(chunk)
                    written += len(chunk)
                    now = time.perf_counter()
                    if now - last_report < PROGRESS_INTERVAL_SECONDS:
                        continue
                    last_report = now
                    logger.info("取得中 %s", format_progress(
                        written // (1024 * 1024),
                        total // (1024 * 1024) if total else None,
                        now - started, "MB"))

    place_once(destination, write, source=url, logger=logger)
