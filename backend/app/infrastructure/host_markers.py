"""本番VMのホストの定期の仕組み（`backend/ops/`のスクリプト）が、最後に通ってから何時間たったか。

スクリプトは通った時刻（UTC、ISO 8601）を1行だけ、印のファイル（`MARKER_DIR`の下の決まった名前）へ書く。ホストの
`/home/ubuntu/ridecompass-cache-data`がコンテナの`data/`（`deploy-backend.yml`の`-v`）なので、スクリプトの書き先と
印の名前は揃える。`/health`が経過時間を返し、定時のActions（`backend/scripts/prod_marker_check.py`）がそれを読んで止まりを知らせる。
"""

import logging
from datetime import datetime

from app.infrastructure.data_paths import DATA_DIR

logger = logging.getLogger("ridecompass.host_markers")

#: 本番の読み手はこのファイルだけだが、テストがディスク（プロセス境界）の置き場を一時ディレクトリへ差し替えるために公開する
#: （testing.md「確かめる高さ」の (c)）。
MARKER_DIR = DATA_DIR


def hours_since(marker: str) -> float | None:
    """印`marker`が書かれてからの時間。記録が無い（手元の開発環境・まだ1回も通っていない本番）か、読めなければNone。"""
    path = MARKER_DIR / marker
    try:
        passed_at = datetime.fromisoformat(path.read_text().strip())
        if passed_at.tzinfo is None:
            raise ValueError(f"時差の無い時刻 {passed_at.isoformat()}")
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        # `/health`が毎回読むので、ここで落とすとそれを待つデプロイまで止まる。読めない理由はここでしか分からない。
        logger.warning("印のファイルが読めない path=%s error=%r", path, exc)
        return None
    return (datetime.now(passed_at.tzinfo) - passed_at).total_seconds() / 3600
