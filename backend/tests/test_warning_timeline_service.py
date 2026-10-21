"""`services/warning_timeline_service.py`——ルートの点から、通る区域ごとの警報級の時系列の段を返す。

時系列は気象庁の応答の形のまま上流の代役から返し、解くクライアント・区域の境界・domainの判定は本物を通す。

ここで見ないもの:
- 時系列の形を解くこと → `test_jma_warning_timeline_client.py`
- 点の区域を通過へまとめる・区域の段の並びを選ぶ・注意報級の判定 → `test_jma_warning_timeline_domain.py`
- 地点から区域を引くこと → `test_jma_area_boundaries.py`
"""

from datetime import datetime

import pytest

from app.domain.route import Coordinates
from app.infrastructure.jma_warning_client import new_area_data_cache
from app.infrastructure.jma_warning_timeline_client import new_timeline_cache
from app.services.warning_timeline_service import WarningTimelineService
from tests.fake_http import client_for
from tests.jma_area_fixtures import (
    CHIYODA_POINT,
    CLASS20_CODE,
    OFFSHORE_POINT,
    THUNDER_ADDITIONS,
    THUNDER_CODES,
    TIMELINE_DOCUMENT,
    TIMELINE_SLOT_STARTS,
    area_lookup_upstream,
)

#: 千代田区の境界（足場の矩形）の外だが、最寄りの区域へ寄せる距離の内側の地点。
NEAR_CHIYODA_POINT = Coordinates(latitude=CHIYODA_POINT.latitude, longitude=CHIYODA_POINT.longitude + 0.015)


def _service(upstream) -> WarningTimelineService:
    return WarningTimelineService(
        client_for(upstream), area_data_cache=new_area_data_cache(), timeline_cache=new_timeline_cache()
    )


async def test_the_route_gets_the_thunder_levels_of_each_area_it_passes_as_the_agency_gave_them(boundary_path):
    """完了の条件2: 段は気象庁のコマのまま（補間も読み替えもせず）、コードと注意報級かを添えて返る。区域の名前は地域マスタの
    名前で、画面はこれを注意報級の時間帯の見出しに出す。"""
    upstream = area_lookup_upstream(boundary_path, timeline_document=TIMELINE_DOCUMENT)
    route = [CHIYODA_POINT, NEAR_CHIYODA_POINT, OFFSHORE_POINT]

    result = await _service(upstream).get_route_timeline(route)

    assert result is not None
    [area] = result.areas
    assert (area.area_code, area.area_name, area.start_index, area.end_index) == (CLASS20_CODE, "千代田区", 0, 1)
    thunder = area.kinds["thunder"]
    assert [(slot.start, slot.code, slot.advisory) for slot in thunder.slots] == [
        (datetime.fromisoformat(start), code, code == "20") for start, code in zip(TIMELINE_SLOT_STARTS, THUNDER_CODES, strict=True)
    ]
    assert all((slot.end - slot.start).total_seconds() == 3 * 60 * 60 for slot in thunder.slots)
    assert thunder.additions == THUNDER_ADDITIONS


async def test_a_route_in_no_area_has_no_passes(boundary_path):
    result = await _service(area_lookup_upstream(boundary_path)).get_route_timeline([OFFSHORE_POINT])

    assert result is not None
    assert result.areas == []


@pytest.mark.parametrize("failure", [
    {"area_data": None, "timeline_document": TIMELINE_DOCUMENT},  # 区域が分からない
    {},  # 時系列を取れない
])
async def test_the_levels_are_unknown_rather_than_empty_when_a_step_fails(boundary_path, failure):
    """取れなかったことを通過の無い空で返すと、画面は注意報級の時間帯が無いと見せる。"""
    upstream = area_lookup_upstream(boundary_path, **failure)

    assert await _service(upstream).get_route_timeline([CHIYODA_POINT]) is None
