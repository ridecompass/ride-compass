"""本番の予報（MSM）の配信が止まっていないかを、本番のbackendの`/api/debug/stats`から見る
（`.github/workflows/prod-route-check.yml`が1日1回呼ぶ）。

    python backend/scripts/prod_msm_check.py

`/api/debug/stats`の`msm`の`healthy`が偽か、`msm`が無いか、応答が読めなければ、理由を出して終了コード1で終わる。
落ちるとGitHub Actionsの失敗の知らせが届く。鮮度の判定（しきい値）はbackendが持ち、ここでは結果だけを読む。
判定の中身は docs/modules/backend/weather-dynamic-layers.md「配信が止まったことの検知」。
"""

from __future__ import annotations

import json
import sys
import urllib.request

REQUEST_TIMEOUT_SECONDS = 30


def problem(origin: str) -> str | None:
    """`origin`のbackendの`/api/debug/stats`を読み、予報の鮮度が落ちていればその理由を返す。落ちていなければNone。"""
    try:
        with urllib.request.urlopen(f"{origin}/api/debug/stats", timeout=REQUEST_TIMEOUT_SECONDS) as response:
            msm = json.load(response)["msm"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        return f"/api/debug/stats が読めない: {error!r}"
    if msm is None:
        return "予報のメタ情報が無いか読めない（backendのWARNINGのログに理由がある）"
    if msm.get("healthy") is not True:
        return (
            f"予報の鮮度が落ちている: 最新run {msm.get('last_run_at')}・run初期時刻から {msm.get('run_age_hours')} 時間・"
            f"予報の残り {msm.get('remaining_hours')} 時間（どちらに当たったかはbackendのWARNINGのログにある）"
        )
    return None


def main() -> int:
    from _production_origins import production_origin

    found = problem(production_origin("backend"))
    if found is not None:
        print(f"失敗: {found}")
        return 1
    print("通った: 予報の新しいrunが届き、予報の残りも足りている")
    return 0


if __name__ == "__main__":
    sys.exit(main())
