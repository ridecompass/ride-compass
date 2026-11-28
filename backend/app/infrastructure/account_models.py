"""利用者・ログインの札・同意の表と、その読み書き。

札は乱数そのものを持たず、hash だけを持つ（表を読まれても札を作れない）。同意は版ごとに1行を足し、やめたら時刻を書く（行は消さない）。
"""

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, Text, UniqueConstraint, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.domain.account import LoginMethod
from app.infrastructure.orm_base import Base


class AccountRow(Base):
    __tablename__ = "accounts"
    __table_args__ = (UniqueConstraint("login_method", "login_subject", name="accounts_login_method_login_subject_key"),)

    id: Mapped[UUID] = mapped_column(primary_key=True)
    login_method: Mapped[str] = mapped_column(Text, nullable=False)
    #: その方法での利用者の番号（Google の ID トークンの`sub`）。
    login_subject: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AccountSessionRow(Base):
    __tablename__ = "account_sessions"

    #: 札の SHA-256 の16進。
    token_hash: Mapped[str] = mapped_column(Text, primary_key=True)
    account_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AccountConsentRow(Base):
    __tablename__ = "account_consents"

    id: Mapped[UUID] = mapped_column(primary_key=True)
    account_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), nullable=False, index=True)
    terms_version: Mapped[int] = mapped_column(Integer, nullable=False)
    agreed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


async def account_for_login(session: AsyncSession, method: LoginMethod, subject: str) -> UUID:
    """その方法と番号の利用者の id。無ければ作る（同じ人が同時にログインしても1行にする）。"""
    await session.execute(
        pg_insert(AccountRow)
        .values(id=uuid4(), login_method=method, login_subject=subject)
        .on_conflict_do_nothing(index_elements=["login_method", "login_subject"])
    )
    return (await session.execute(
        select(AccountRow.id).where(AccountRow.login_method == method, AccountRow.login_subject == subject)
    )).scalar_one()


async def insert_session(session: AsyncSession, account_id: UUID, *, token_hash: str, expires_at: datetime) -> None:
    session.add(AccountSessionRow(token_hash=token_hash, account_id=account_id, expires_at=expires_at))


async def account_for_session(session: AsyncSession, token_hash: str, *, now: datetime) -> UUID | None:
    """札の効く利用者の id。札が無い・期限が切れていればNone。"""
    return (await session.execute(
        select(AccountSessionRow.account_id).where(
            AccountSessionRow.token_hash == token_hash, AccountSessionRow.expires_at > now)
    )).scalar_one_or_none()


async def delete_session(session: AsyncSession, token_hash: str) -> None:
    await session.execute(delete(AccountSessionRow).where(AccountSessionRow.token_hash == token_hash))


async def has_consent(session: AsyncSession, account_id: UUID, terms_version: int) -> bool:
    """その版への同意があり、やめていないか。"""
    return (await session.execute(
        select(AccountConsentRow.id).where(
            AccountConsentRow.account_id == account_id,
            AccountConsentRow.terms_version == terms_version,
            AccountConsentRow.withdrawn_at.is_(None),
        ).limit(1)
    )).first() is not None


async def insert_consent(session: AsyncSession, account_id: UUID, terms_version: int) -> None:
    session.add(AccountConsentRow(id=uuid4(), account_id=account_id, terms_version=terms_version))


async def withdraw_consents(session: AsyncSession, account_id: UUID) -> None:
    """やめていない同意の全部に、やめた時刻を書く。"""
    await session.execute(
        update(AccountConsentRow)
        .where(AccountConsentRow.account_id == account_id, AccountConsentRow.withdrawn_at.is_(None))
        .values(withdrawn_at=func.now())
    )
