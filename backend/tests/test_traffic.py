"""`domain/traffic.py`のうち、Pythonで値を返す入口の道の階級（`highway_rank`）。

ここで見ないもの:
- 点のタグから停止要因・補給休憩の種別を引き当てるSQLと、数える種別へ畳むSQL → `test_tag_classification.py`
- 道の通行方向を決めるSQL → `test_resolve_direction.py`
- 停止の待ちが区間の所要時間へ足されること → `test_leg_costs.py`
- 待ちの秒が管理画面から変えた値を読むこと → `test_tuning_overrides.py`
- 階級を比べて交差点の待ちを足すこと → `test_turn_structure.py`
- 停止要因の種別を地図の凡例の行へ写すこと → `test_primary_attributes.py`
"""

from app.domain import traffic


def test_minor_roads_share_one_rank_below_tertiary_and_above_paths():
    minor = {traffic.highway_rank(h) for h in ("unclassified", "residential", "living_street", "service")}

    assert len(minor) == 1
    assert traffic.highway_rank("cycleway") < minor.pop() < traffic.highway_rank("tertiary")
