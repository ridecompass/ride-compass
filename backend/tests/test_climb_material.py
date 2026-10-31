"""登りの量の材料（`elevation_gain_m_per_km`）が、派生した区間の標高から、進行方向に登った量として探索に届くこと。

区間は道路網の形の導出（`batch/derive_topology.py`）が切り、標高は派生の段（`batch/derive_elevation.py`）が出したものを
探索と同じ読み出し（`infrastructure/road_graph_repository.py: RoadGraphRepository.get_edge_material_arrays`）で読む。道は
東へ登って下る1本で、途中の頂点に別の道を付けると、そこで2区間に切れる。

ここで見ないもの:
- 区間の中の頂点から獲得標高を積むこと → `test_elevation_values.py`
- 密度の軸の費用とルートの値が、ほかの区間の点数や時刻と合わさる形 → `test_leg_costs.py`・`test_route.py`
"""

import functools

import numpy as np
import pytest

from app.batch import derive_elevation, derive_topology
from app.batch.dem_tile_store import PRODUCT_PRIORITY
from app.batch.ingest import SourceRecord
from app.domain.axis_definitions import averages_density
from app.domain.evaluation import DensityAxisColumn, density_costs
from app.domain.region import BoundingBox
from app.infrastructure.road_graph_repository import RoadGraphRepository
from tests.axis_system_fixture import linear, shaped_axis
from tests.conftest import raw_connection
from tests.source_ingest import dem_tile_records, ingest_records, way_record

pytestmark = pytest.mark.asyncio(loop_scope="module")

CLIMB = "elevation_gain_m_per_km"
LAT = 35.68
#: 道1の頂点の経度。真ん中の頂点（ノード3）が峠。
LONS = (139.700, 139.702, 139.704, 139.706, 139.708)
#: 道1と、峠から北へ出る道2を囲む範囲。
AREA = BoundingBox(min_latitude=LAT - 0.005, min_longitude=LONS[0] - 0.005,
                   max_latitude=LAT + 0.005, max_longitude=LONS[-1] + 0.005)
BASE_M, PEAK_M, END_M = 100.0, 120.0, 110.0


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
        await derive_elevation.derive(conn, previous=None)


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

    # 標高の画素（約4m）の分だけ、頂点の標高が道の上の値からずれる。
    assert values[0] * distance_m[0] / 1000 == pytest.approx(climbed_m, abs=0.5)


async def test_an_axis_on_the_climb_alone_costs_the_same_however_the_road_is_cut(road_graph_session):
    """登りの量だけを項にした軸は密度の軸で、探索の費用は区間の登った量に比例して足す。峠で2区間に切っても、登った量の和と
    費用の和は1区間のままと同じ。区間の平均の勾配で点数にすると、切ったときの急な側だけが重くなり、切り方で選ぶ道が変わる。"""
    axis = shaped_axis(linear(CLIMB, breakpoints=((0.0, 0.0), (50.0, 100.0))))
    assert averages_density(axis)

    def climbed_and_cost(values: np.ndarray, distance_m: np.ndarray) -> tuple[float, float]:
        cost = density_costs({axis.axis_id: DensityAxisColumn(shape=axis.shape, inputs=values)},
                             {axis.axis_id: np.zeros(len(values))}, distance_m, speed_kmh=20.0)
        return float(np.sum(values * distance_m / 1000)), float(np.sum(cost[axis.axis_id].score_seconds))

    whole = climbed_and_cost(*await _climb_of_way_1(road_graph_session, cut_at_the_peak=False, forward=True))
    cut = climbed_and_cost(*await _climb_of_way_1(road_graph_session, cut_at_the_peak=True, forward=True))

    # 獲得標高は区間ごとに0.1mへ丸めて持つ。
    assert cut == pytest.approx(whole, rel=0.01)
    assert whole[1] > 0
