"""自分の口（`/api/me`）: Google でのログイン・ログアウト・自分の状態・同意・自分の走り。

どの口も本人の分だけを読み書きし、ほかの人の走りは無いものとして404を返す（あるかどうかも見せない）。
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from app.api.account_auth import (
    clear_session_cookie,
    optional_account,
    session_cookie,
    set_session_cookie,
    signed_in_account,
)
from app.api.dependencies import get_account_service, get_google_id_token_verifier
from app.api.rate_limit import enforce_rate_limit
from app.config import settings
from app.domain.account import TERMS_VERSION, AccountStatus
from app.domain.ride_track import RideDetail, RideSummary
from app.domain.strict_model import StrictModel
from app.infrastructure.google_identity import GoogleIdTokenVerifier, LoginNotConfiguredError
from app.services.account_service import AccountService

router = APIRouter(prefix="/api/me", tags=["account"])


class GoogleLoginRequest(StrictModel):
    #: Google Identity Services が画面へ渡した ID トークン。
    credential: str


class ConsentRequest(StrictModel):
    #: 画面が見せて同意を得た規約の版。
    terms_version: int


@router.get("", response_model=AccountStatus)
async def get_status(account_id: UUID | None = Depends(optional_account),
                     accounts: AccountService = Depends(get_account_service)) -> AccountStatus:
    return await accounts.status(account_id)


@router.post("/google-login", response_model=AccountStatus)
async def sign_in_with_google(
    body: GoogleLoginRequest,
    request: Request,
    response: Response,
    accounts: AccountService = Depends(get_account_service),
    verifier: GoogleIdTokenVerifier = Depends(get_google_id_token_verifier),
) -> AccountStatus:
    """トークンを確かめて札を cookie で返す。効かないトークンは401、ログインの設定が無い環境は503。"""
    enforce_rate_limit(request, "google-login", settings.google_login_rate_limit_per_minute)
    try:
        signed_in = await accounts.sign_in_with_google(verifier, body.credential)
    except LoginNotConfiguredError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="ログインの設定がありません") from exc
    if signed_in is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Google のログインを確かめられませんでした")
    token, account_status = signed_in
    set_session_cookie(response, token)
    return account_status


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def sign_out(response: Response, token: str | None = Depends(session_cookie),
                   accounts: AccountService = Depends(get_account_service)) -> None:
    """札の行と cookie を消す。札が無くても消した状態として返す。"""
    if token is not None:
        await accounts.sign_out(token)
    clear_session_cookie(response)


@router.put("/consent", status_code=status.HTTP_204_NO_CONTENT)
async def consent(body: ConsentRequest, account_id: UUID = Depends(signed_in_account),
                  accounts: AccountService = Depends(get_account_service)) -> None:
    """今の規約の版に同意する。画面が見せた版が今の版でなければ409（古い規約への同意を今の同意に数えない）。"""
    if body.terms_version != TERMS_VERSION:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="規約が新しくなっています。読み直してください")
    await accounts.consent(account_id)


@router.delete("/consent", status_code=status.HTTP_204_NO_CONTENT)
async def withdraw_consent(account_id: UUID = Depends(signed_in_account),
                           accounts: AccountService = Depends(get_account_service)) -> None:
    """同意をやめ、以後の走りを受けない。それまでの走りは残す（消すのは本人が1件ずつ）。"""
    await accounts.withdraw_consent(account_id)


@router.get("/rides", response_model=list[RideSummary])
async def list_rides(account_id: UUID = Depends(signed_in_account),
                     accounts: AccountService = Depends(get_account_service)) -> list[RideSummary]:
    return await accounts.rides(account_id)


@router.get("/rides/{ride_id}", response_model=RideDetail)
async def get_ride(ride_id: UUID, account_id: UUID = Depends(signed_in_account),
                   accounts: AccountService = Depends(get_account_service)) -> RideDetail:
    ride = await accounts.ride(account_id, ride_id)
    if ride is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="走りが見つかりません")
    return ride


@router.delete("/rides/{ride_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_ride(ride_id: UUID, account_id: UUID = Depends(signed_in_account),
                      accounts: AccountService = Depends(get_account_service)) -> None:
    if not await accounts.delete_ride(account_id, ride_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="走りが見つかりません")
