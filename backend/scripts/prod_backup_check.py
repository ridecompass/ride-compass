"""本番のDBのバックアップが止まっていないかを、本番のbackendの`/health`から見る
（`.github/workflows/prod-route-check.yml`が1日1回呼ぶ）。

    python backend/scripts/prod_backup_check.py

`/health`の`admin_data_backup_age_hours`（最後に置けてからの時間）が上限を超えたか、値が無いか、`/health`が
読めなければ、理由を出して終了コード1で終わる。落ちるとGitHub Actionsの失敗の知らせが届く。
上限の根拠は docs/modules/backend/cross-cutting-infrastructure.md「本番DBのバックアップ」。
"""

from __future__ import annotations

import json
import sys
import urllib.request

#: 最後に置けてからの時間の上限（時間）。
MAX_AGE_HOURS = 25.0
REQUEST_TIMEOUT_SECONDS = 30


def problem(origin: str) -> str | None:
    """`origin`のbackendの`/health`を読み、バックアップが止まっていればその理由を返す。止まっていなければNone。"""
    try:
        with urllib.request.urlopen(f"{origin}/health", timeout=REQUEST_TIMEOUT_SECONDS) as response:
            health = json.load(response)
    except (OSError, ValueError) as error:
        return f"/health が読めない: {error}"
    age = health.get("admin_data_backup_age_hours")
    if age is None:
        return "最後に置けた時刻の記録が無いか読めない（backendのWARNINGのログに理由がある）"
    if age > MAX_AGE_HOURS:
        return f"最後に置けてから {age} 時間（上限 {MAX_AGE_HOURS} 時間）"
    return None


def main() -> int:
    from _production_origins import production_origin

    found = problem(production_origin("backend"))
    if found is not None:
        print(f"失敗: {found}")
        return 1
    print(f"通った: 最後に置けてから上限 {MAX_AGE_HOURS} 時間以内")
    return 0


if __name__ == "__main__":
    sys.exit(main())
