"""運営が名前を付けて全員に配る、生成の条件のひな形（ルートのプロファイル）。

ひな形が持つのは、ルートの形に依らない条件だけ: 負担（`domain/cost_preference.py: CostPreference`）と、道の段の行ごとの段
（鍵は`domain/road_avoidance.py: AvoidanceRow.key`）。書いていない軸と行は標準（倍率は標準・段は行の既定の段）。
ひな形が名指す軸と行は、いつも今ある費用の軸と道の段の行だけにする: ひな形の書き込みは今に無い名を断り（`missing_references`）、
費用の軸・道の区分の書き込みは、同じ取引でひな形から消えた名の設定を外す（`without_missing_axes`・`without_missing_rows`）。
読む側（画面・生成）は、ひな形の名を今の軸と行に照らし直さない。
"""

from pydantic import Field, model_validator

from app.domain.cost_axes import CostAxisDefinitions, cost_axis_ids
from app.domain.cost_preference import CostPreference
from app.domain.road_avoidance import AvoidanceLevel, avoidance_rows
from app.domain.road_classes import RoadClassDefinitions
from app.domain.strict_model import StrictModel


class PublishedRouteProfile(StrictModel):
    """利用者へ配るひな形1つ（公開のものだけを配る）。"""

    name: str = Field(min_length=1)
    description: str
    cost_preference: CostPreference
    #: 道の段の行の鍵→段。
    road_avoidance: dict[str, AvoidanceLevel]


class RouteProfile(PublishedRouteProfile):
    """管理APIが読み書きするひな形1つ。非公開のものは利用者へ配らない。"""

    published: bool


class RouteProfiles(StrictModel):
    """ひな形の全体（並びは画面に出す順）。管理APIはこの形で1回に読み、1回に書く。"""

    profiles: list[RouteProfile]

    @model_validator(mode="after")
    def _names_are_unique(self) -> "RouteProfiles":
        names = [profile.name for profile in self.profiles]
        repeated = sorted({name for name in names if names.count(name) > 1})
        if repeated:
            raise ValueError(f"ひな形の名前が重なっています: {repeated}")
        return self

    def published(self) -> list[PublishedRouteProfile]:
        return [PublishedRouteProfile.model_validate(profile.model_dump(exclude={"published"}))
                for profile in self.profiles if profile.published]


EMPTY_ROUTE_PROFILES = RouteProfiles(profiles=[])


def _row_keys(road_classes: RoadClassDefinitions) -> set[str]:
    return {row.key for row in avoidance_rows(road_classes)}


def missing_references(
    profiles: RouteProfiles, cost_axes: CostAxisDefinitions, road_classes: RoadClassDefinitions
) -> list[str]:
    """今の費用の軸`cost_axes`と道の段の行（`road_classes`から導く）に無い名を指す設定を、ひな形の名前つきで並べる
    （無ければ空）。管理APIの書き込みと起動時の読み込みの両方が通す。"""
    rows = _row_keys(road_classes)
    problems = []
    for profile in profiles.profiles:
        try:
            profile.cost_preference.check_cost_axis_ids(cost_axes)
        except ValueError as error:
            problems.append(f"{profile.name}: {error}")
        unknown_rows = sorted(set(profile.road_avoidance) - rows)
        if unknown_rows:
            problems.append(f"{profile.name}: 道の段の行に無い鍵 {unknown_rows}")
    return problems


def without_missing_axes(profiles: RouteProfiles, cost_axes: CostAxisDefinitions) -> tuple[RouteProfiles, list[str]]:
    """費用の軸`cost_axes`に無い軸の倍率と無効を外したひな形と、外した設定（ひな形の名前つき）。"""
    known = set(cost_axis_ids(cost_axes))
    removed = []
    kept = []
    for profile in profiles.profiles:
        preference = profile.cost_preference
        gone = sorted((set(preference.multipliers) | set(preference.disabled_axes)) - known)
        if gone:
            removed.append(f"{profile.name}: 軸 {gone}")
            preference = preference.model_copy(update={
                "multipliers": {key: value for key, value in preference.multipliers.items() if key in known},
                "disabled_axes": [key for key in preference.disabled_axes if key in known],
            })
        kept.append(profile.model_copy(update={"cost_preference": preference}))
    return RouteProfiles(profiles=kept), removed


def without_missing_rows(profiles: RouteProfiles, road_classes: RoadClassDefinitions) -> tuple[RouteProfiles, list[str]]:
    """道の段の行（`road_classes`から導く）に無い鍵の段を外したひな形と、外した設定（ひな形の名前つき）。"""
    rows = _row_keys(road_classes)
    removed = []
    kept = []
    for profile in profiles.profiles:
        gone = sorted(set(profile.road_avoidance) - rows)
        if gone:
            removed.append(f"{profile.name}: 道の段の行 {gone}")
        kept.append(profile.model_copy(update={
            "road_avoidance": {key: level for key, level in profile.road_avoidance.items() if key in rows}}))
    return RouteProfiles(profiles=kept), removed


#: プロセス内のひな形の全体。起動で読み込む（`services/route_profile_service.py: refresh_route_profiles`）までは None。
_current: RouteProfiles | None = None


def current_route_profiles() -> RouteProfiles:
    """プロセス内のひな形の全体。読み込む前に読むのは起動の順の誤りなので、止める。"""
    if _current is None:
        raise RuntimeError("ひな形を読み込む前に読んだ（services/definitions_loading.py: refresh_definitions を先に通す）")
    return _current


def replace_route_profiles(profiles: RouteProfiles) -> None:
    """プロセス内の全体を差し替える。束縛を1回替えるだけなので、別スレッドの読みは前か後の全体のどちらかを見る。"""
    global _current
    _current = profiles
