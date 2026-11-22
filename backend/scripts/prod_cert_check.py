"""本番の frontend と backend の宛先の TLS 証明書が、切れる前に更新されているかを見る
（`.github/workflows/prod-route-check.yml`が1日1回呼ぶ）。

    python backend/scripts/prod_cert_check.py

どちらかの宛先で、残りの日数が下限を切ったか、証明書の確かめが通らないか、繋がらなければ、理由を出して終了コード1で終わる。
落ちるとGitHub Actionsの失敗の知らせが届く。証明書と更新の置き場は docs/architecture/tech-stack.md「本番の宛先」。
"""

from __future__ import annotations

import socket
import ssl
import sys
import time
from urllib.parse import urlsplit

#: 残りの日数の下限。certbot は残り30日から更新を試みるので、これを切ったら10日以上更新が通っていない。
MIN_DAYS_LEFT = 20.0
CONNECT_TIMEOUT_SECONDS = 30


def not_after(host: str) -> float:
    """`host`の443番へ証明書を確かめて繋ぎ、証明書の期限（エポック秒）を返す。確かめが通らなければ`ssl.SSLError`。"""
    context = ssl.create_default_context()
    with socket.create_connection((host, 443), timeout=CONNECT_TIMEOUT_SECONDS) as raw:
        with context.wrap_socket(raw, server_hostname=host) as tls:
            return ssl.cert_time_to_seconds(tls.getpeercert()["notAfter"])


def problem(origin: str, now: float) -> str | None:
    """`origin`の証明書が更新されていなければその理由を返す。更新されていればNone。"""
    host = urlsplit(origin).hostname
    try:
        expires = not_after(host)
    except OSError as error:
        return f"{host}: 証明書を確かめて繋げない: {error}"
    days = (expires - now) / 86400
    if days < MIN_DAYS_LEFT:
        return f"{host}: 証明書の残りが {days:.1f} 日（下限 {MIN_DAYS_LEFT} 日）。VM の certbot の更新が通っていない"
    return None


def main() -> int:
    from _production_origins import production_origin

    found = [p for side in ("frontend", "backend") if (p := problem(production_origin(side), time.time())) is not None]
    for p in found:
        print(f"失敗: {p}")
    if found:
        return 1
    print(f"通った: frontend と backend の証明書の残りは {MIN_DAYS_LEFT} 日以上")
    return 0


if __name__ == "__main__":
    sys.exit(main())
