"""較正値を使う計算が、その値では成り立たないときに較正値を名指して止まること（`domain/tuning.py: require_tuning`と、
それを呼ぶ所）。管理画面の保存は値を断らないので、壊れる値で探索・派生の作り直しが壊れた結果（負の費用・NaN・SQLの失敗）を
出さずに止まり、管理者が直す較正値を文から引けることを見る。

使う所ごとには、壊れる値1つで止まることだけを見る（条件の両側は`require_tuning`の表が持つ）。値は管理APIの書き口
（`services/tuning_service.py: TuningService.save_value`）で置き、テストの後に足場が元の値へ戻す。

ここで見ないもの:
- 止まったルート生成の失敗の文が利用者へ届くこと → 失敗の文の決め方（`api/failure_replies.py: failure_reply`）が例外の文をそのまま返す
- 較正値の値が表から読まれること → `test_tuning_overrides.py`
"""

import math

import numpy as np
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.batch import derive_counts, derive_elevation
from app.domain import cycling_speed, ledger_costs, route_search, traffic
from app.domain.cost_preference import CostPreference
from app.domain.road_avoidance import level_multipliers
from app.domain.tuning import (
    ELEVATION_PROFILE_STEP_ID,
    STOP_CLUSTER_DISTANCE_ID,
    TUNING_PARAMETERS_BY_ID,
    TURN_BEARING_DISTANCE_ID,
    TuningValueError,
    require_tuning,
)
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.infrastructure.tuning_overrides import TuningOverrideStore
from app.services.tuning_service import TuningService
from tests.conftest import raw_connection
from tests.profile_fixture import profiles as road_profiles
from tests.tuning_fixture import TUNING

#: DBを読むテストだけに付ける（PostGIS統合テストのループはファイルで共有する）。
_ON_DATABASE = pytest.mark.asyncio(loop_scope="module")

_PARAM = "speed.walking_kmh"


@pytest.mark.parametrize(("value", "holds", "refused"), [
    (1.0, True, False),
    (1.0, False, True),
    (math.nan, True, True),
    (math.inf, True, True),
])
def test_a_value_is_refused_when_the_condition_fails_or_it_is_not_finite(value, holds, refused):
    """条件を満たしても有限でない値は断る——無限大・NaNは比べ方によって条件を通り、費用を無限大・NaNにする。"""
    if not refused:
        require_tuning({_PARAM: value}, holds, "条件C")
        return
    with pytest.raises(TuningValueError) as raised:
        require_tuning({_PARAM: value}, holds, "条件C")
    message = str(raised.value)
    assert TUNING_PARAMETERS_BY_ID[_PARAM].label in message and _PARAM in message and repr(value) in message
    assert "条件C" in message


def _speed_model() -> None:
    cycling_speed.SegmentSpeedModel(cycling_speed.RiderProfile(cruise_speed_kmh=20.0), road_profiles([0.0, 0.0]),
                                    np.array([1000.0]), np.array([TUNING["speed.crr"]]), np.zeros(1))


def _pareto() -> None:
    one = np.zeros(1)
    route_search.rank_by_pareto_layers(np.array([0]), one, one, one, np.ones(1),
                                       max_items=1, max_examined=None, tie_by_distance=False)


#: 使う所（呼ぶと値を読む入口）と、そこで計算が成り立たない値。
_UNUSABLE = [
    ("evaluation.penalty_strength", 0.0, lambda: ledger_costs.current_ledger_parameters(CostPreference())),
    ("cost.effort_alpha", -1.0, lambda: ledger_costs.current_ledger_parameters(CostPreference())),
    ("cost.burden_seconds_per_km", -1.0, lambda: ledger_costs.current_ledger_parameters(CostPreference())),
    ("stop.signal_share", -1.0, lambda: traffic.stop_event("stop", "signal")),
    ("stop.signal_seconds", -1.0, lambda: traffic.stop_event("stop", "signal")),
    ("stop.slowed_speed_ratio", 1.5, lambda: traffic.stop_event("stop", "signal")),
    ("speed.mass_kg", 0.0, _speed_model),
    ("speed.cda_m2", -1.0, _speed_model),
    ("speed.extra_power_per_force", -1.0, _speed_model),
    ("speed.max_climb_power_ratio", 0.5, _speed_model),
    ("speed.walking_kmh", 0.0, _speed_model),
    ("search.retrace_penalty_multiplier", 0.5, lambda: route_search.retrace_penalized(np.zeros(1), np.zeros(1))),
    ("search.pareto_distance_quantum_m", 0.0, _pareto),
]


@_ON_DATABASE
@pytest.mark.parametrize(("param_id", "value", "use"), _UNUSABLE, ids=[row[0] for row in _UNUSABLE])
async def test_a_search_stops_naming_a_value_it_cannot_compute_with(road_graph_session: AsyncSession, param_id, value, use):
    await TuningService(road_graph_session, TuningOverrideStore(road_graph_session)).save_value(param_id, value)

    with pytest.raises(TuningValueError, match=param_id):
        use()


def test_avoidance_stops_naming_a_multiplier_it_cannot_take_the_root_of():
    """避け方の倍率は呼び手が読んで渡す。"""
    with pytest.raises(TuningValueError, match="avoidance.avoid_cost_multiplier"):
        level_multipliers(0.0)


@_ON_DATABASE
async def test_a_rebuild_stops_naming_a_value_its_sql_cannot_run_with(road_graph_repository: RoadGraphRepository):
    """派生の作り直しは較正値を引数で受ける。"""
    async with raw_connection() as conn:
        with pytest.raises(TuningValueError, match=STOP_CLUSTER_DISTANCE_ID):
            await derive_counts.derive(conn, cluster_distance_m=-1.0, accident_fatal_weight=1.0, accident_match_distance_m=1.0)
        with pytest.raises(TuningValueError, match=ELEVATION_PROFILE_STEP_ID):
            await derive_elevation.derive(conn, profile_step_m=0.0, bridge_end_radius_m=1.0)
    with pytest.raises(TuningValueError, match=TURN_BEARING_DISTANCE_ID):
        road_graph_repository.stream_network_edges(1, {TURN_BEARING_DISTANCE_ID: -1.0})
