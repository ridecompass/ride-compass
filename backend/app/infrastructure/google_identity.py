"""Google の ID トークン（Google Identity Services が画面へ渡すもの）を確かめて、利用者の番号（`sub`）を取り出す。

確かめるのは Google の公式のライブラリ（`google.oauth2.id_token.verify_oauth2_token`）で、署名（Google の公開の証明書を取って照らす）・
`aud`（クライアント ID）・`iss`・`exp`を見る。`sub`は Google のアカウントごとに一意で使い回されないので、利用者はこれだけで見分け、
トークンに載るメールと名前は読まない。
"""

import asyncio
from dataclasses import dataclass

from google.auth import exceptions as google_auth_exceptions
from google.auth.transport import Request as GoogleTransport
from google.oauth2 import id_token

from app.infrastructure.debug_log import log_external_call


class LoginNotConfiguredError(Exception):
    """クライアント ID が無い環境。ログインを断る。"""


@dataclass(frozen=True)
class GoogleIdTokenVerifier:
    #: OAuth のクライアント ID（秘密の値ではない）。空ならログインを断る。
    client_id: str
    #: 証明書を取る HTTP の口（`google.auth.transport.requests.Request`）。
    transport: GoogleTransport

    async def subject(self, token: str) -> str | None:
        """確かめた`sub`。署名が合わない・宛先が違う・発行元が違う・期限が切れた・形の崩れたトークンならNone。
        証明書を取れなければ`google.auth.exceptions.TransportError`を送り出す（トークンの誤りと分ける）。"""
        if not self.client_id:
            raise LoginNotConfiguredError("Google のクライアント ID が設定されていません")
        with log_external_call("auth:google-id-token") as fields:
            try:
                # 証明書の取得が同期の HTTP なので、イベントループを塞がないよう別のスレッドで確かめる。
                claims = await asyncio.to_thread(id_token.verify_oauth2_token, token, self.transport, self.client_id)
            except google_auth_exceptions.TransportError:
                raise
            except (ValueError, google_auth_exceptions.GoogleAuthError) as exc:
                # 発行元の違いは`GoogleAuthError`、ほかの誤りは`ValueError`で来る。利用者の側の誤りなので失敗には数えない。
                fields["result"] = "rejected"
                fields["reason"] = type(exc).__name__
                return None
        return str(claims["sub"])
