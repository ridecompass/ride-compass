"""`domain/jma_warning_timeline.py`——警報級の時系列の区域の段の並びの選び方・ルートの点の区域を通過へまとめること。

ここで見ないもの:
- 気象庁の応答の形を解くこと・段が注意報級かの読み替え → `test_jma_warning_timeline_client.py`
- 地点から区域を引くこと → `test_jma_area_boundaries.py`
- 通過と段を応答へ組むこと → `test_warning_timeline_service.py`
"""

from datetime import datetime

import pytest

from app.domain.jma_warning_timeline import (
    LAND_AREA_NAME,
    RoutePass,
    TimelineKind,
    TimelineLevels,
    TimeSlot,
    WarningTimeline,
    route_passes,
)


_SLOT = (TimeSlot(start=datetime(2026, 10, 21, 18), end=datetime(2026, 10, 21, 21)),)


def _levels(area_name: str | None, code: str, kind_type: str = "雷危険度") -> TimelineLevels:
    return TimelineLevels(kind_type=kind_type, area_name=area_name, slots=_SLOT, codes=(code,), advisories=(False,),
                          additions=())


@pytest.mark.parametrize(("class20", "class10", "chosen"), [
    pytest.param((_levels(None, "20"),), (_levels(None, "01"),), "20", id="二次細分区域の段を先に引く"),
    pytest.param((_levels(None, "20", "風危険度"),), (_levels(None, "01"),), "01", id="区域に種別が無ければ一次細分区域"),
    pytest.param(
        (_levels("海上", "30"), _levels(LAND_AREA_NAME, "20")), (), "20", id="所で分けていれば陸上",
    ),
    pytest.param((_levels("山沿い", "20"),), (), None, id="陸上でない所だけなら選ばない"),
])
def test_the_levels_of_an_area_are_its_own_before_its_subdivision(class20, class10, chosen):
    timeline = WarningTimeline(class20_levels={"a": class20}, class10_levels={"b": class10})

    levels = timeline.levels_for("a", "b", TimelineKind.THUNDER)

    assert (None if levels is None else levels.codes[0]) == chosen


@pytest.mark.parametrize(("codes", "passes"), [
    pytest.param(
        ["a", "a", "b", "b", "b"], [RoutePass("a", 0, 2), RoutePass("b", 2, 4)],
        id="通過は次の通過が始まる点で終わる",
    ),
    pytest.param(
        ["a", None, "a", "b", None], [RoutePass("a", 0, 3), RoutePass("b", 3, 3)],
        id="区域に入らない点は飛ばす",
    ),
    pytest.param(
        ["a", "b", "a"], [RoutePass("a", 0, 1), RoutePass("b", 1, 2), RoutePass("a", 2, 2)],
        id="離れてまた通れば別の通過",
    ),
    pytest.param([None, None], [], id="どこにも入らない"),
])
def test_route_points_are_grouped_into_passes_in_order(codes, passes):
    """通過の点の番号から、画面がルートの上の距離と通る時刻を決める。区切りがずれると、その区域の段を別の区域の
    時刻に当てる。"""
    assert route_passes(codes) == passes
