"""ログイン・同意・自分の走りの読み書き（`/api/me`のサービス層）。取引の境界はここが持つ（構造仕様7）。"""

import hashlib
import secrets
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.account import SESSION_LIFETIME, TERMS_VERSION, AccountStatus
from app.domain.ride_track import RideDetail, RideSummary
from app.infrastructure.account_models import (
    account_for_login,
    account_for_session,
    delete_session,
    has_consent,
    insert_consent,
    insert_session,
    withdraw_consents,
)
from app.infrastructure.google_identity import GoogleIdTokenVerifier
from app.infrastructure.ride_gpx import read_ride_lines
from app.infrastructure.ride_track_models import account_ride, account_ride_summaries, delete_account_ride


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class AccountService:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def sign_in_with_google(
            self, verifier: GoogleIdTokenVerifier, google_id_token: str) -> tuple[str, AccountStatus] | None:
        """確かめたトークンの利用者（無ければ作る）に新しい札を作り、札とその人の状態を返す。トークンが効かなければNone。"""
        subject = await verifier.subject(google_id_token)
        if subject is None:
            return None
        account_id = await account_for_login(self._session, "google", subject)
        token = secrets.token_urlsafe(32)
        await insert_session(self._session, account_id, token_hash=_token_hash(token),
                             expires_at=datetime.now(UTC) + SESSION_LIFETIME)
        await self._session.commit()
        return token, await self.status(account_id, verifier.client_id)

    async def sign_out(self, token: str) -> None:
        await delete_session(self._session, _token_hash(token))
        await self._session.commit()

    async def account_for(self, token: str | None) -> UUID | None:
        """札の効く利用者。札が無い・効かなければNone。"""
        if token is None:
            return None
        return await account_for_session(self._session, _token_hash(token), now=datetime.now(UTC))

    async def has_current_consent(self, account_id: UUID) -> bool:
        return await has_consent(self._session, account_id, TERMS_VERSION)

    async def status(self, account_id: UUID | None, google_client_id: str) -> AccountStatus:
        consented = account_id is not None and await self.has_current_consent(account_id)
        return AccountStatus(signed_in=account_id is not None, consented=consented, terms_version=TERMS_VERSION,
                             google_client_id=google_client_id or None)

    async def consent(self, account_id: UUID) -> None:
        """今の規約の版に同意する。同意していれば何もしない。"""
        if not await self.has_current_consent(account_id):
            await insert_consent(self._session, account_id, TERMS_VERSION)
            await self._session.commit()

    async def withdraw_consent(self, account_id: UUID) -> None:
        """同意をやめる。それまでの走りは残す。"""
        await withdraw_consents(self._session, account_id)
        await self._session.commit()

    async def rides(self, account_id: UUID) -> list[RideSummary]:
        """自分の走りを、走り始めの新しい順に。"""
        return await account_ride_summaries(self._session, account_id)

    async def ride(self, account_id: UUID, ride_id: UUID) -> RideDetail | None:
        found = await account_ride(self._session, account_id, ride_id)
        if found is None:
            return None
        summary, gpx = found
        track = {"type": "MultiLineString",
                 "coordinates": [[[lon, lat] for lat, lon in line] for line in read_ride_lines(gpx)]}
        return RideDetail(**summary.model_dump(), track=track)

    async def delete_ride(self, account_id: UUID, ride_id: UUID) -> bool:
        deleted = await delete_account_ride(self._session, account_id, ride_id)
        await self._session.commit()
        return deleted
