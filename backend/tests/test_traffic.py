"""`domain/traffic.py`のうち、Pythonで値を返す入口の道の階級（`highway_rank`）。

ここで見ないもの:
- 点のタグから停止要因・補給休憩の種別を引き当てるSQLと、数える種別へ畳むSQL → `test_tag_classification.py`
- 道の通行方向を決めるSQL → `test_resolve_direction.py`
- 停止の待ちが区間の所要時間へ足されること → `test_leg_costs.py`
- 待ちの秒が管理画面から変えた値を読むこと → `test_tuning_overrides.py`
- 階級を比べて交差点の待ちを足すこと → `test_turn_structure.py`
- 停止要因の種別を地図の凡例の行へ写すこと → `test_primary_attributes.py`
"""

import pytest

from app.domain import traffic


def test_minor_roads_share_one_rank_below_tertiary_and_above_paths():
    minor = {traffic.highway_rank(h) for h in ("unclassified", "residential", "living_street", "service")}

    assert len(minor) == 1
    assert traffic.highway_rank("cycleway") < minor.pop() < traffic.highway_rank("tertiary")


def test_a_stop_event_takes_its_share_of_the_wait_and_of_the_kickoff_and_a_slowdown_only_part_of_the_kickoff():
    """止まる出来事は 割合 × 待ち を時間に、割合ぶんの漕ぎ出しを体力に数える。減速だけの出来事は、巡航速度の半分から戻す
    ので漕ぎ出しは（1 − 0.5²）回ぶん。"""
    stop = traffic.StopEvent(share=0.5, wait_seconds=42.0, slows_only=False)
    slowdown = traffic.StopEvent(share=1.0, wait_seconds=8.0, slows_only=True)

    assert (stop.expected_seconds, stop.stop_equivalents(0.5)) == pytest.approx((21.0, 0.5))
    assert (slowdown.expected_seconds, slowdown.stop_equivalents(0.5)) == pytest.approx((8.0, 0.75))
