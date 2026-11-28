"""利用者のログインの札（cookie）を読む認可の境界。

札は backend の名前だけに付く cookie で持つ（`Domain`を付けない）。スクリプトから読めず（`HttpOnly`）、HTTPS だけで送られ（`Secure`）、
ほかのサイトから始まった書き込みには付かない（`SameSite=Lax`）。
"""

from uuid import UUID

from fastapi import Depends, HTTPException, Response, status
from fastapi.security import APIKeyCookie

from app.api.dependencies import get_account_service
from app.domain.account import SESSION_LIFETIME
from app.services.account_service import AccountService

SESSION_COOKIE = "ridecompass_session"

session_cookie = APIKeyCookie(name=SESSION_COOKIE, auto_error=False)


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(SESSION_COOKIE, token, max_age=int(SESSION_LIFETIME.total_seconds()),
                        httponly=True, secure=True, samesite="lax")


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, httponly=True, secure=True, samesite="lax")


async def optional_account(token: str | None = Depends(session_cookie),
                           accounts: AccountService = Depends(get_account_service)) -> UUID | None:
    """札の効く利用者。札が無い・効かなければNone。"""
    return await accounts.account_for(token)


async def signed_in_account(account_id: UUID | None = Depends(optional_account)) -> UUID:
    """札の効く利用者。札が無い・効かなければ401。"""
    if account_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="ログインしていません")
    return account_id


async def consenting_account(account_id: UUID = Depends(signed_in_account),
                             accounts: AccountService = Depends(get_account_service)) -> UUID:
    """今の規約の版に同意した利用者。同意していなければ403。"""
    if not await accounts.has_current_consent(account_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="走りの記録に同意していません")
    return account_id
