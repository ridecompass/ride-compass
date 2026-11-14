"""登りの量の材料（`elevation_gain_m_per_km`）が、派生した区間の標高から、進行方向に登った量として探索に届くこと。

区間は道路網の形の導出（`batch/derive_topology.py`）が切り、標高は派生の段（`batch/derive_elevation.py`）が出したものを
探索と同じ読み出し（`infrastructure/road_graph_repository.py: RoadGraphRepository.get_edge_material_arrays`）で読む。道は
東へ登って下る1本で、途中の頂点に別の道を付けると、そこで2区間に切れる。

ここで見ないもの:
- 区間の中の頂点から獲得標高を積むこと → `test_elevation_values.py`
"""

import functools

import numpy as np
import pytest

from app.batch import derive_topology
from app.batch.dem_tile_store import PRODUCT_PRIORITY
from app.batch.ingest import SourceRecord
from app.domain.region import BoundingBox
from app.infrastructure.road_graph_repository import RoadGraphRepository
from tests.conftest import raw_connection
from tests.source_ingest import dem_tile_records, derive_elevation_at_default_step, ingest_records, way_record

pytestmark = pytest.mark.asyncio(loop_scope="module")

CLIMB = "elevation_gain_m_per_km"
LAT = 35.68
#: 道1の頂点の経度。真ん中の頂点（ノード3）が峠。
LONS = (139.700, 139.702, 139.704, 139.706, 139.708)
#: 道1と、峠から北へ出る道2を囲む範囲。
AREA = BoundingBox(min_latitude=LAT - 0.005, min_longitude=LONS[0] - 0.005,
                   max_latitude=LAT + 0.005, max_longitude=LONS[-1] + 0.005)
BASE_M, PEAK_M, END_M = 100.0, 120.0, 110.0
#: 断面の刻み（m）。道1（約723m）を20の刻みに、峠までの半分を10の刻みに分け、峠に点が乗る幅にする——刻みの点が峠を
#: 挟むと、峠の頂を削って登りを少なく数える（刻みより細かい起伏は数えない）。
PROFILE_STEP_M = 36.5


def _elevation(lon: float, lat: float) -> float:
    """峠まで登り、そこから下る。登りは20m、下りは10m。"""
    start, peak, end = LONS[0], LONS[2], LONS[-1]
    if lon <= peak:
        return BASE_M + (PEAK_M - BASE_M) * (lon - start) / (peak - start)
    return PEAK_M + (END_M - PEAK_M) * (lon - peak) / (end - peak)


@functools.cache
def _dem_records() -> list[SourceRecord]:
    return dem_tile_records(PRODUCT_PRIORITY[0], 15, AREA, _elevation)


async def _derive(*, cut_at_the_peak: bool) -> None:
    ways = [way_record(1, [(lon, LAT) for lon in LONS], [1, 2, 3, 4, 5], {"highway": "secondary"})]
    if cut_at_the_peak:
        ways.append(way_record(2, [(LONS[2], LAT), (LONS[2], LAT + 0.002)], [3, 6], {"highway": "residential"}))
    await ingest_records("osm_way", ways, bbox=AREA)
    await ingest_records("dem", _dem_records())
    async with raw_connection() as conn:
        await derive_topology.derive(conn)
        await derive_elevation_at_default_step(conn, profile_step_m=PROFILE_STEP_M)


async def _climb_of_way_1(session, *, cut_at_the_peak: bool, forward: bool) -> tuple[np.ndarray, np.ndarray]:
    """道1の区間の、材料の値（m/km）と長さ（m）。読んだ後に読むトランザクションを閉じる——開いたままだと、次の派生が表を
    作り直せずに待ち続ける。"""
    await _derive(cut_at_the_peak=cut_at_the_peak)
    async with raw_connection() as conn:
        segments = [row["segment_index"] for row in await conn.fetch(
            "SELECT segment_index FROM road_edges WHERE osm_way_id = 1 ORDER BY segment_index")]
    assert len(segments) == (2 if cut_at_the_peak else 1)
    arrays = await RoadGraphRepository(session).get_edge_material_arrays(
        [1] * len(segments), segments, [forward] * len(segments), 1)
    await session.rollback()
    return arrays.numeric_values[:, arrays.numeric_ids.index(CLIMB)], arrays.distance_m


@pytest.mark.parametrize(("forward", "climbed_m"), [
    (True, PEAK_M - BASE_M),
    (False, PEAK_M - END_M),  # 逆向きに辿ると、順向きの下りを登る
], ids=["順向き", "逆向き"])
async def test_the_climb_is_what_the_road_climbs_in_the_direction_travelled(road_graph_session, forward, climbed_m):
    """向きを取り違えると、下り坂を登り坂として避け、登り坂を楽な道として選ぶ。"""
    values, distance_m = await _climb_of_way_1(road_graph_session, cut_at_the_peak=False, forward=forward)

    # 標高の画素（約4m）の分だけ、点の標高が道の上の値からずれる。
    assert values[0] * distance_m[0] / 1000 == pytest.approx(climbed_m, abs=0.5)
