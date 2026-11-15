"""本番VMのホストの定期の仕組み（`backend/ops/`）が止まっていないかを、本番のbackendの`/health`から見る
（`.github/workflows/prod-route-check.yml`が1日1回、仕組みごとに呼ぶ）。

    python backend/scripts/prod_marker_check.py admin_data_backup_age_hours

`/health`の指定した欄（最後に通ってからの時間）が上限を超えたか、値が無いか、`/health`が読めなければ、
理由を出して終了コード1で終わる。落ちるとGitHub Actionsの失敗の知らせが届く。
上限の根拠は docs/modules/backend/cross-cutting-infrastructure.md の、仕組みごとの節（「本番DBのバックアップ」「元の取り直し」）。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request

#: `/health`の欄ごとの、最後に通ってからの時間の上限（時間）。
MAX_AGE_HOURS = {
    "admin_data_backup_age_hours": 25.0,
    "source_refresh_age_hours": 8 * 24.0,
}
REQUEST_TIMEOUT_SECONDS = 30


def problem(origin: str, field: str) -> str | None:
    """`origin`のbackendの`/health`の欄`field`を読み、止まっていればその理由を返す。止まっていなければNone。"""
    try:
        with urllib.request.urlopen(f"{origin}/health", timeout=REQUEST_TIMEOUT_SECONDS) as response:
            health = json.load(response)
    except (OSError, ValueError) as error:
        return f"/health が読めない: {error}"
    age = health.get(field)
    if age is None:
        return f"{field}: 最後に通った時刻の記録が無いか読めない（backendのWARNINGのログに理由がある）"
    if age > MAX_AGE_HOURS[field]:
        return f"{field}: 最後に通ってから {age} 時間（上限 {MAX_AGE_HOURS[field]} 時間）"
    return None


def main() -> int:
    from _production_origins import production_origin

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("field", choices=sorted(MAX_AGE_HOURS))
    field = parser.parse_args().field
    found = problem(production_origin("backend"), field)
    if found is not None:
        print(f"失敗: {found}")
        return 1
    print(f"通った: {field} は上限 {MAX_AGE_HOURS[field]} 時間以内")
    return 0


if __name__ == "__main__":
    sys.exit(main())
