"""調査の道具（`run_probe.py`が手元で走らせるプローブ）が、本番の接続先を受け取る口。

`run_probe.py`は接続先を環境変数で渡す。同じプローブは本番のコンテナの中・デプロイのあとの確かめでも走り、
そこには`.env.oracle.local`もリポジトリの根の`scripts/`も無いので、標準ライブラリと`app`だけで読める。
"""

import os

PROBE_DATABASE_URL = "PROBE_DATABASE_URL"
PROBE_ASYNCPG_DSN = "PROBE_ASYNCPG_DSN"


def probe_database_url(given: str | None) -> str:
    """プローブの接続先。引数で渡されたもの、無ければ`run_probe.py`が渡したもの、無ければ設定値。

    DBへ書くバッチ（`app/batch/common.py: run_batch_cli`）はこれを読まない——調査のつもりの環境から
    本番へ書かないため。
    """
    url = given or os.environ.get(PROBE_DATABASE_URL)
    if url:
        return url
    from app.config import settings

    return settings.database_url
