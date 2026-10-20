"""較正値の上書き（`infrastructure/tuning_overrides.py`）のテスト。

既定値は宣言が持ち、DBは差分だけを持つ。

ここで見ないもの:
- 書き込みの取引の区切りと、書いた値をプロセスへ反映する順 → `test_tuning_service.py`
- HTTPの受け口 → `test_tuning_admin_routes.py`、派生バッチが同じ値を読むこと → `test_derive_cli.py`
"""


import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain import tuning
from app.domain.tuning import TUNING_PARAMETERS, TUNING_PARAMETERS_BY_ID
from app.infrastructure.tuning_overrides import (
    TuningOverrideError,
    clear_override,
    merge_overrides,
    read_overrides,
    set_override,
)
from app.services.tuning_service import refresh_tuning_values

# 範囲の広いものを選ぶ（値を動かしても宣言の範囲に収まるように）。
_PARAM = "turn.right_seconds"


class TestMerge:
    def test_an_override_replaces_only_that_value(self):
        merged = merge_overrides({_PARAM: 30.0})

        assert merged[_PARAM] == 30.0
        others = {k: v for k, v in merged.items() if k != _PARAM}
        assert others == {p.id: p.default for p in TUNING_PARAMETERS if p.id != _PARAM}


    @pytest.mark.parametrize(
        ("overrides", "accepted"),
        [
            # 緩めた上限を上限より下げると、緩めたつもりで絞ることになる
            ({"search.turnaround_relaxed_overlap_ratio": 0.5}, False),
            # 見込みの下限が上限を超えると、リングも帰りの見込みも裏返る
            ({"search.loop_to_outbound_ratio_min": 2.5}, False),
            # 両方を同じ向きに動かせば、片方だけでは破る値も受け付ける
            ({"search.loop_to_outbound_ratio_min": 2.5, "search.loop_to_outbound_ratio_max": 2.5}, True),
        ],
    )
    def test_overrides_that_reverse_a_pair_of_values_are_refused(self, overrides, accepted):
        if accepted:
            assert merge_overrides(overrides).items() >= overrides.items()
        else:
            with pytest.raises(TuningOverrideError):
                merge_overrides(overrides)

@pytest.mark.asyncio(loop_scope="module")
async def test_override_round_trip_reaches_the_running_value(road_graph_session: AsyncSession):
    """書いた値が、プロセス内の`TUNING_VALUES`まで届いて消費者に効く。"""
    default = TUNING_PARAMETERS_BY_ID[_PARAM].default
    changed = default + 7.0
    try:
        await set_override(road_graph_session, _PARAM, changed)
        await road_graph_session.commit()

        assert await read_overrides(road_graph_session) == {_PARAM: changed}

        await refresh_tuning_values(road_graph_session)
        assert tuning.tuning_value(_PARAM) == changed

        # 既定値と同じ値を書くと行が消える（差分だけを持つ形を保つ）。
        await set_override(road_graph_session, _PARAM, default)
        await road_graph_session.commit()
        assert await read_overrides(road_graph_session) == {}

        await refresh_tuning_values(road_graph_session)
        assert tuning.tuning_value(_PARAM) == default
    finally:
        await clear_override(road_graph_session, _PARAM)
        await road_graph_session.commit()
        await refresh_tuning_values(road_graph_session)


@pytest.mark.asyncio(loop_scope="module")
async def test_one_of_a_pair_can_be_moved_past_the_default_of_the_other_once_the_other_is_moved(
    road_graph_session: AsyncSession,
):
    """上限を下げてから緩めた上限を、上限の既定より下へ下げられる。1件を書く前の検算が相手を既定のまま見ると、
    片方ずつしか書けない画面からは、この組み合わせへ動かせない。"""
    lower, upper = "search.turnaround_max_overlap_ratio", "search.turnaround_relaxed_overlap_ratio"
    try:
        await set_override(road_graph_session, lower, 0.4)
        await set_override(road_graph_session, upper, 0.5)
        await road_graph_session.commit()

        assert merge_overrides(await read_overrides(road_graph_session)).items() >= {lower: 0.4, upper: 0.5}.items()
    finally:
        await clear_override(road_graph_session, lower)
        await clear_override(road_graph_session, upper)
        await road_graph_session.commit()

@pytest.mark.asyncio(loop_scope="module")
async def test_writing_an_undeclared_id_is_rejected(road_graph_session: AsyncSession):
    with pytest.raises(TuningOverrideError):
        await set_override(road_graph_session, "turn.no_such_value", 1.0)
