from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

# DBへ届かない・DBが答えないときに出る例外。`api/failure_replies.py`がこれだけを503にし、実装の誤り
# （TypeError・AttributeError等）とほかのOSError（ファイルの読み書き等）は500のまま表へ出す。
# - SQLAlchemyError: 接続を張る段階と実行中の失敗（asyncpgの例外はDBAPIErrorへ訳される）とプールの待ち切れ
# - ConnectionError: 接続の拒否・切断（asyncpgが訳さずに出す）
# - TimeoutError: 接続を張る段階の時間切れ（asyncpgの接続の`timeout`。SQLAlchemyは訳さない）
DB_UNAVAILABLE_ERRORS: tuple[type[Exception], ...] = (SQLAlchemyError, ConnectionError, TimeoutError)

# エンジン（コネクションプール）は系統ごとにアプリ全体で1つだけ生成し、セッションファクトリが持つ。
# create_async_engineは遅延接続のため、DBが実際に起動していなくてもこの時点では失敗しない。
_session_factory: async_sessionmaker[AsyncSession] | None = None


def _new_session_factory() -> async_sessionmaker[AsyncSession]:
    engine = create_async_engine(settings.database_url, pool_pre_ping=True)
    return async_sessionmaker(engine, expire_on_commit=False)


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = _new_session_factory()
    return _session_factory


# ルート生成と、全表走査を伴う管理APIの集計が使う。どちらも1本の接続を長く持つため、タイル配信とはプールを分ける。
_route_generation_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_route_generation_session_factory() -> async_sessionmaker[AsyncSession]:
    global _route_generation_session_factory
    if _route_generation_session_factory is None:
        _route_generation_session_factory = _new_session_factory()
    return _route_generation_session_factory


async def dispose_engines() -> None:
    """エンジンを閉じる。次の取得で作り直す。"""
    global _session_factory, _route_generation_session_factory
    for factory in (_session_factory, _route_generation_session_factory):
        if factory is not None:
            await factory.kw["bind"].dispose()
    _session_factory = _route_generation_session_factory = None
