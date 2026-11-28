"""ひな形の表の、全体の読みと全体の入れ替え。書く関数はcommitしない（取引の区切りは`services/route_profile_service.py`が持つ）。"""

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.route_profiles import EMPTY_ROUTE_PROFILES, RouteProfiles
from app.infrastructure.route_profile_models import RouteProfilesRow


async def read_route_profiles(session: AsyncSession) -> RouteProfiles:
    """表の全体。行が無ければ、ひな形は0件。"""
    row = await session.scalar(select(RouteProfilesRow))
    return EMPTY_ROUTE_PROFILES if row is None else RouteProfiles.model_validate(row.profiles)


async def replace_route_profiles_row(session: AsyncSession, profiles: RouteProfiles) -> None:
    """全体を入れ替える（行が無ければ入れる）。"""
    statement = insert(RouteProfilesRow).values(only_one=True, profiles=profiles.model_dump(mode="json"))
    await session.execute(statement.on_conflict_do_update(
        index_elements=["only_one"], set_={"profiles": statement.excluded.profiles}))
