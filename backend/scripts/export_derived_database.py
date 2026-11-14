"""OSM の派生データベースを書き出し、配る置き場へ置く（`infrastructure/derived_database_export.py`）。

backend の定期のジョブ（`app/main.py`）が毎日、別のプロセスとして打つ。今の世代・今のコードの形の書き出しが既にあれば何もしない。
取込・派生の作り直し・DBのバックアップが走っていれば書かずに終え、次の回に書く——取込は生データを、作り直しは派生の表を
入れ替えるので、その途中を読むと道と値が別々の世代になる。

実行方法（backendディレクトリから）:
    .venv\\Scripts\\python.exe scripts\\export_derived_database.py
"""

import asyncio
import logging
import sys
from pathlib import Path

from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.batch.common import SOURCE_DATA_LOCK, batch_session_factory, configure_cli_logging
from app.infrastructure import derived_database_export

logger = logging.getLogger("ridecompass.derived_database")

_TRY_LOCK = text("SELECT pg_try_advisory_lock(hashtext(:lock))")


async def run(database_url: str | None) -> int:
    async with batch_session_factory(database_url) as session_factory, session_factory() as session:
        # 鍵は接続に付く。書き出しと同じセッション（同じ接続）で取り、外すのは入口を出てエンジンが接続を閉じるとき
        # ——書き出しが落ちてトランザクションが壊れても、外し損ねない。
        if not (await session.execute(_TRY_LOCK, {"lock": SOURCE_DATA_LOCK})).scalar_one():
            logger.info("取込・派生の作り直し・バックアップが走っているので、派生データベースを書き出さずに終えます")
            return 0
        await derived_database_export.ensure_current(session)
    return 0


def main() -> int:
    configure_cli_logging()
    return asyncio.run(run(None))


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
