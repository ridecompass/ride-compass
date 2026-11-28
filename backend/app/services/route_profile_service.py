"""ひな形の全体の読み込みと、管理APIの入れ替えと、費用の軸・道の区分の書き込みに合わせた外し。

**プロセス内の全体（`domain/route_profiles.py: replace_route_profiles`）へ書くのはここだけ**（起動時の読み込みと、管理APIで
書いた直後と、費用の軸・道の区分の書き込みで外した直後）。ひな形は費用の軸と道の段の行を名指すので、どちらも読んだ後に読む
（`services/definitions_loading.py`）。
"""

import logging
from collections.abc import Callable

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.cost_axes import current_cost_axes
from app.domain.road_classes import current_road_classes
from app.domain.route_profiles import RouteProfiles, missing_references, replace_route_profiles
from app.infrastructure.cost_axis_repository import read_cost_axes
from app.infrastructure.road_class_repository import read_road_classes
from app.infrastructure.route_profile_repository import read_route_profiles, replace_route_profiles_row

logger = logging.getLogger("ridecompass.route_profiles")


class RouteProfilesRejectedError(ValueError):
    """書く全体を断った。文は運用者が読む断りの文。"""


async def refresh_route_profiles(session: AsyncSession) -> None:
    """表の全体をプロセス内へ読み込む（起動時。区分と費用の軸を読んだ後）。行が無ければひな形は0件。今の軸と行に無い名を
    指していれば、外さずに名指して起動を止める（バックアップから戻した行は管理APIを通らないので、ここで初めて確かめる）。"""
    profiles = await read_route_profiles(session)
    problems = missing_references(profiles, current_cost_axes(), current_road_classes())
    if problems:
        raise RuntimeError(f"ひな形を読み込めません: 今の軸と道の段の行に無い名を指しています（{'／'.join(problems)}）")
    replace_route_profiles(profiles)
    logger.info("ひな形を読み込みました profiles=%d", len(profiles.profiles))


#: 表のひな形から、書き込みで消える名の設定を外す関数（外した全体と、外した設定）。
Pruning = Callable[[RouteProfiles], tuple[RouteProfiles, list[str]]]


async def write_pruned_route_profiles(session: AsyncSession, prune: Pruning) -> tuple[RouteProfiles, list[str]]:
    """表のひな形を`prune`で外して、外した設定があれば同じ取引へ書く（commitしない）。費用の軸・道の区分の書き込みが、自分の
    全体を書くのと同じ取引の中で呼び、確定したら`apply_pruned_route_profiles`へ渡す。"""
    profiles, removed = prune(await read_route_profiles(session))
    if removed:
        await replace_route_profiles_row(session, profiles)
    return profiles, removed


def apply_pruned_route_profiles(profiles: RouteProfiles, removed: list[str]) -> None:
    """確定した外しをプロセス内へ反映し、外した設定を書いた運用者へ知らせる（ひな形の中身が書き込みの外で変わる）。"""
    replace_route_profiles(profiles)
    if removed:
        logger.warning("消えた軸・道の段の行の設定を、ひな形から外しました（%s）", "／".join(removed))


class RouteProfileAdminService:
    """管理APIの全体の読みと入れ替え。入れ替えは1つの取引で、確定してからプロセス内へ反映する。"""

    def __init__(self, session: AsyncSession):
        self._session = session

    async def read(self) -> RouteProfiles:
        return await read_route_profiles(self._session)

    async def replace(self, profiles: RouteProfiles) -> RouteProfiles:
        """全体を入れ替え、書いた全体を返す。名指す先はプロセス内でなくDBの軸と区分に照らす（プロセス内は確定の後に書き換わる）。"""
        session = self._session
        cost_axes = await read_cost_axes(session)
        problems = (["負担の種類の定義がまだありません"] if cost_axes is None
                    else missing_references(profiles, cost_axes, await read_road_classes(session)))
        if problems:
            await session.rollback()
            raise RouteProfilesRejectedError(f"ひな形が通りません（{'／'.join(problems)}）")
        await replace_route_profiles_row(session, profiles)
        await session.commit()
        replace_route_profiles(profiles)
        return profiles
