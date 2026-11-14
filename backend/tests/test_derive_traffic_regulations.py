"""交通規制の派生（`derive_traffic_regulations.derive`）が、規制を区間へ当てた値。

見るのは、線に沿う区間（折れた線なら区間に沿う所）と面の中の区間に当たり、規制を横切るだけの区間（帯にまるごと入る
短い区間も）と離れた区間に当たらないこと、1つの区間に2つの規制が当たれば列ごとに強い方を取ること。

ここで見ないもの:
- 規制1件がいつ・誰に効くかの判断 → `test_traffic_regulation.py`
"""

import pytest
import pytest_asyncio
import shapely
from shapely.geometry import LineString, Polygon

from app.batch import derive_topology, derive_traffic_regulations
from app.batch.ingest import SourceRecord
from app.domain.traffic_regulation import ALL_DAY, TIMED
from app.domain.tuning import REGULATION_EDGE_SHARE_ID, REGULATION_LINE_HALF_WIDTH_ID, REGULATION_MAX_ANGLE_ID
from app.infrastructure.source_models import PEDESTRIAN_ROAD_KIND
from tests.source_ingest import ingest_records, way_record
from tests.tuning_fixture import TUNING

# moduleスコープのroad_graph_engine（conftest.py）の上のDBを使うため、.claude/rules/testing-backend.mdのパターン2どおり
# loop_scope="module"が必須。
pytestmark = pytest.mark.asyncio(loop_scope="module")

LAT = 35.68
#: 道の長さ（経度の差。約90m）。
LENGTH = 0.001
#: 交差点の中の区間ほどの短い道の長さ（経度の差。約9m）。帯の幅より短く、横切る線の帯にまるごと入る。
SHORT_LENGTH = 0.0001
#: 線の規制を道からずらす幅（緯度の差。約5m）。帯の半幅より狭い。
OFFSET = 0.000045
ALONG, INSIDE, CROSSED, APART, SHORT_CROSSED, BENT = 1, 2, 3, 4, 5, 6


def _road(way_id: int) -> tuple[tuple[float, float], tuple[float, float]]:
    """道`way_id`の両端。道どうしは道の長さより離して東西に並べる。"""
    west = 139.70 + way_id * 0.01
    return (west, LAT), (west + (SHORT_LENGTH if way_id == SHORT_CROSSED else LENGTH), LAT)


def _regulation(key: str, shape, **attrs: str) -> SourceRecord:
    """歩行者用道路の規制1件。`attrs`は配布の列のうち値を持つもの（ほかは空）。"""
    return SourceRecord(natural_key=key, geom_wkb=shapely.to_wkb(shape), attrs={
        "共通規制種別コード": PEDESTRIAN_ROAD_KIND, "点・線・面コード": "3" if isinstance(shape, Polygon) else "2", **attrs})


def _along(way_id: int) -> LineString:
    (lon0, lat), (lon1, _) = _road(way_id)
    return LineString([(lon0, lat + OFFSET), (lon1, lat + OFFSET)])


def _bent(way_id: int) -> LineString:
    """道に沿ってから北へ折れて道の長さの2倍だけ続く線。始点と終点を結ぶ向きは、道と45度より大きく違う。"""
    (lon0, lat), (lon1, _) = _road(way_id)
    return LineString([(lon0, lat + OFFSET), (lon1, lat + OFFSET), (lon1, lat + OFFSET + 2 * LENGTH)])


def _around(way_id: int) -> Polygon:
    (lon0, lat), (lon1, _) = _road(way_id)
    return Polygon([(lon0 - 0.0005, lat - 0.0005), (lon1 + 0.0005, lat - 0.0005),
                    (lon1 + 0.0005, lat + 0.0005), (lon0 - 0.0005, lat + 0.0005)])


def _across(way_id: int) -> LineString:
    (lon0, lat), (lon1, _) = _road(way_id)
    middle = (lon0 + lon1) / 2
    return LineString([(middle, lat - 0.001), (middle, lat + 0.001)])


@pytest_asyncio.fixture(loop_scope="module")
async def derived(derive_conn):
    """道を取り込んで区間まで作り、規制を取り込んで段を流した状態。区間の鍵 → (全体の時間帯, 自転車の時間帯)。"""
    ways = (ALONG, INSIDE, CROSSED, APART, SHORT_CROSSED, BENT)
    await ingest_records("osm_way", [way_record(w, _road(w), [w * 10, w * 10 + 1]) for w in ways], conn=derive_conn)
    await derive_topology.derive(derive_conn)
    await ingest_records("jartic_regulation", [
        # 対象の車両が無い規制は、自転車も対象。
        _regulation("along", _along(ALONG)),
        # 面の中の区間には、終日の自動車だけの規制と、時間帯の自転車も対象の規制が当たる。
        _regulation("around", _around(INSIDE), **{"対象車両コード1_A": "10"}),
        _regulation("around_timed", _around(INSIDE), **{"規制時間1_開始": "800", "規制時間1_終了": "2000"}),
        _regulation("across", _across(CROSSED)),
        _regulation("short_across", _across(SHORT_CROSSED)),
        _regulation("bent", _bent(BENT)),
    ], conn=derive_conn)
    await derive_traffic_regulations.derive(
        derive_conn, line_half_width_m=TUNING[REGULATION_LINE_HALF_WIDTH_ID], edge_share=TUNING[REGULATION_EDGE_SHARE_ID],
        max_angle_deg=TUNING[REGULATION_MAX_ANGLE_ID])
    rows = await derive_conn.fetch(
        "SELECT osm_way_id, pedestrian_road, pedestrian_road_bicycle FROM edge_traffic_regulations")
    return {row["osm_way_id"]: (row["pedestrian_road"], row["pedestrian_road_bicycle"]) for row in rows}


async def test_regulations_reach_edges_along_lines_and_inside_areas(derived):
    assert derived == {ALONG: (ALL_DAY, ALL_DAY), INSIDE: (ALL_DAY, TIMED), BENT: (ALL_DAY, ALL_DAY)}
