"""テストの Google のログインの足場。Google の証明書の配り口（網の向こう）だけを偽にし、確かめるライブラリと口は本物を通す。

自分で作った鍵で署名した ID トークンを、その鍵の証明書を配る偽の配り口と組にして渡す。
"""

import json
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from google.auth import crypt, jwt
from google.auth.transport import Request, Response

from app.api.dependencies import get_google_id_token_verifier
from app.domain.account import TERMS_VERSION
from app.infrastructure.google_identity import GoogleIdTokenVerifier

CLIENT_ID = "test-client.apps.googleusercontent.com"
KEY_ID = "test-key"
GOOGLE_ISSUER = "https://accounts.google.com"


def _key_pair() -> tuple[bytes, bytes]:
    """RSA の秘密鍵（PEM）と、その公開鍵の自己署名の証明書（PEM）。"""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test")])
    now = datetime.now(UTC)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1).not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=3650))
            .sign(key, hashes.SHA256()))
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return pem, cert.public_bytes(serialization.Encoding.PEM)


GOOGLE_KEY, GOOGLE_CERT = _key_pair()
#: 配り口に載っていない鍵（同じ鍵の名前で署名した偽のトークンを作る）。
FORGED_KEY, _ = _key_pair()


def id_token(sub: str, *, key: bytes = GOOGLE_KEY, lifetime_s: int = 3600, **claims: Any) -> str:
    """Google が出すのと同じ形の ID トークン。`claims`で既定の欄（`aud`・`iss`）を上書きする。"""
    now = int(time.time())
    payload = {"iss": GOOGLE_ISSUER, "aud": CLIENT_ID, "sub": sub, "iat": now - 10, "exp": now + lifetime_s} | claims
    return jwt.encode(crypt.RSASigner.from_string(key, KEY_ID), payload).decode()


class _CertsResponse(Response):
    def __init__(self, status: int):
        self._status = status

    @property
    def status(self) -> int:
        return self._status

    @property
    def headers(self) -> dict:
        return {}

    @property
    def data(self) -> bytes:
        return json.dumps({KEY_ID: GOOGLE_CERT.decode()}).encode()


class CertsTransport(Request):
    """Google の証明書の配り口。`status`が200でなければ配れなかった答えを返す。"""

    def __init__(self, status: int = 200):
        self.status = status

    def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kwargs) -> Response:
        return _CertsResponse(self.status)


def use_google(override_dependency, *, client_id: str = CLIENT_ID, transport: Request | None = None) -> None:
    """ログインの口が、偽の配り口とこのクライアント ID で確かめるようにする。"""
    verifier = GoogleIdTokenVerifier(client_id=client_id, transport=transport or CertsTransport())
    override_dependency(get_google_id_token_verifier, lambda: verifier)


async def sign_in(client: httpx.AsyncClient, sub: str) -> httpx.Response:
    return await client.post("/api/me/google-login", json={"credential": id_token(sub)})


async def sign_in_and_consent(client: httpx.AsyncClient, sub: str) -> None:
    """ログインして今の規約の版に同意する（札は`client`の cookie に残る）。"""
    assert (await sign_in(client, sub)).status_code == 200
    assert (await client.put("/api/me/consent", json={"terms_version": TERMS_VERSION})).status_code == 204
