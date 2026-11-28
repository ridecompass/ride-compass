"""JARTIC の一方通行の規制を効かせた道の通行方向（`batch/derive_way_directions.py: derive`が書く`way_directions`）。

同じ道を、規制を取り込む前と後で段に通し、前後を比べる。見るのは、自転車を除く規制が当たる一方通行の道は自転車が両方向に
辿れ、自転車も対象の規制が当たる道は（タグが自転車を除いていても）タグの向きの一方向になり、両方向の道へ一方通行を足さず、
道の一部にだけ当たる規制は効かず、上下線分離の判定は規制で変わらないこと。

ここで見ないもの:
- 規制の場所を区間へ当てる帯・割合・向きの差 → `test_derive_traffic_regulations.py`
- タグから通行方向を決める規則 → `test_resolve_direction.py`
"""

from typing import NamedTuple

import pytest
import pytest_asyncio
import shapely
from shapely.geometry import LineString

from app.batch import derive_topology, derive_way_directions
from app.batch.ingest import SourceRecord
from app.domain.geo import KM_PER_DEGREE_LATITUDE
from app.domain.tuning import DIVIDED_NAMED_GAP_ID, REGULATION_EDGE_SHARE_ID
from app.infrastructure.source_models import ONE_WAY_KIND
from tests.source_ingest import WAY_ORIGIN, ingest_records, stage_tuning, way_record
from tests.tuning_fixture import TUNING

# moduleスコープのroad_graph_engine（conftest.py）の上のDBを使うため、.claude/rules/testing-backend.mdのパターン2どおり
# loop_scope="module"が必須。
pytestmark = pytest.mark.asyncio(loop_scope="module")

BASE_LON, BASE_LAT = WAY_ORIGIN
#: 道の長さ（経度、約180m）。
LENGTH = 0.002
#: 場面どうしの間隔（緯度、約1.1km）。規制の帯よりも上下線の距離よりも十分に遠い。
SPACING = 0.01
#: 規制の線を道からずらす幅（緯度、約5m）。帯の半幅より狭い。
OFFSET = 0.000045

#: 規制の条件の組（配布の列のうち値を持つもの）。組を持たない規制は全部の車両に効く。
ALL_VEHICLES: dict[str, str] = {}
#: 普通自転車を除く（除外車両の区分 D の自転車の位）。
EXCEPT_BICYCLES = {"除外車両コード1_D": "100"}
#: 終日は自転車を除き、朝だけは自転車も対象。
EXCEPT_BICYCLES_BUT_MORNING = {**EXCEPT_BICYCLES, "規制時間2_開始": "700", "規制時間2_終了": "900"}


class Scene(NamedTuple):
    """道1本と、道に沿って当てる規制（条件の組の列）と、規制の前後の通行方向。"""

    tags: dict[str, str]
    regulations: list[dict[str, str]]
    before: str
    after: str


SCENES: dict[str, Scene] = {
    "自転車を除く規制が当たる一方通行": Scene({"oneway": "yes"}, [EXCEPT_BICYCLES], "forward", "both"),
    "自転車も対象の規制が、タグが自転車を除く一方通行に当たる": Scene(
        {"oneway": "yes", "oneway:bicycle": "no"}, [ALL_VEHICLES], "both", "forward"),
    "自転車も対象の規制が逆向きの一方通行に当たる": Scene({"oneway": "-1"}, [ALL_VEHICLES], "backward", "backward"),
    "自転車も対象の規制が両方向の道に当たる": Scene({}, [ALL_VEHICLES], "both", "both"),
    "自転車を除く規制と自転車も対象の規制が両方当たる": Scene(
        {"oneway": "yes"}, [EXCEPT_BICYCLES, ALL_VEHICLES], "forward", "forward"),
    "時間帯だけ自転車も対象の組を持つ規制": Scene({"oneway": "yes"}, [EXCEPT_BICYCLES_BUT_MORNING], "forward", "forward"),
}

#: 道の一部にだけ当たる場面。道を横切る道で区間を2つに切り、短い方の区間（道の長さの割合の較正値より短い）にだけ規制を沿わせる。
PARTIAL_WAY = 900
PARTIAL_CUT = LENGTH * TUNING[REGULATION_EDGE_SHARE_ID] * 0.6
#: 上下線の場面。同じ名前の対向一方通行を名前の距離の内側に並べ、規制は片側に沿わせる。
DIVIDED_WAYS = (910, 920)


def _lat(index: int) -> float:
    return BASE_LAT + SPACING * index


def _east(index: int) -> list[tuple[float, float]]:
    return [(BASE_LON, _lat(index)), (BASE_LON + LENGTH, _lat(index))]


def _regulation(key: str, points: list[tuple[float, float]], attrs: dict[str, str]) -> SourceRecord:
    line = LineString([(lon, lat + OFFSET) for lon, lat in points])
    return SourceRecord(natural_key=key, geom_wkb=shapely.to_wkb(line),
                        attrs={"共通規制種別コード": ONE_WAY_KIND, "点・線・面コード": "2", **attrs})


def _ways() -> list[SourceRecord]:
    ways = [way_record(i + 1, _east(i), [(i + 1) * 10, (i + 1) * 10 + 1], {"highway": "residential", **scene.tags})
            for i, scene in enumerate(SCENES.values())]
    partial = len(SCENES)
    lat = _lat(partial)
    ways += [
        way_record(PARTIAL_WAY, [(BASE_LON, lat), (BASE_LON + PARTIAL_CUT, lat), (BASE_LON + LENGTH, lat)],
                   [9000, 9001, 9002], {"highway": "residential", "oneway": "yes"}),
        way_record(PARTIAL_WAY + 1, [(BASE_LON + PARTIAL_CUT, lat), (BASE_LON + PARTIAL_CUT, lat + 0.001)],
                   [9001, 9003], {"highway": "residential"}),
    ]
    divided = _east(partial + 1)
    gap = (TUNING[DIVIDED_NAMED_GAP_ID] - 10) / (KM_PER_DEGREE_LATITUDE * 1000.0)
    tags = {"highway": "primary", "oneway": "yes", "name": "A"}
    ways += [way_record(DIVIDED_WAYS[0], divided, [9100, 9101], tags),
             way_record(DIVIDED_WAYS[1], [(lon, lat + gap) for lon, lat in divided[::-1]], [9200, 9201], tags)]
    return ways


def _regulations() -> list[SourceRecord]:
    regulations = [_regulation(f"{i}-{k}", _east(i), attrs)
                   for i, scene in enumerate(SCENES.values()) for k, attrs in enumerate(scene.regulations)]
    partial = len(SCENES)
    regulations.append(_regulation("partial", [(BASE_LON, _lat(partial)), (BASE_LON + PARTIAL_CUT, _lat(partial))],
                                   EXCEPT_BICYCLES))
    regulations.append(_regulation("divided", _east(partial + 1), EXCEPT_BICYCLES))
    return regulations


async def _directions(conn) -> dict[int, tuple[str, bool]]:
    await derive_way_directions.derive(conn, **stage_tuning("directions"))
    rows = await conn.fetch("SELECT osm_way_id, direction, divided FROM way_directions")
    return {row["osm_way_id"]: (row["direction"], row["divided"]) for row in rows}


class BeforeAfter(NamedTuple):
    before: dict[int, tuple[str, bool]]
    after: dict[int, tuple[str, bool]]


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def before_after(derive_conn) -> BeforeAfter:
    """道を取り込んで区間を作り、規制の無いまま段を流した通行方向と、規制を取り込んで流し直した通行方向。"""
    await ingest_records("osm_way", _ways(), conn=derive_conn)
    await derive_topology.derive(derive_conn)
    before = await _directions(derive_conn)
    await ingest_records("jartic_regulation", _regulations(), conn=derive_conn)
    return BeforeAfter(before, await _directions(derive_conn))


@pytest.mark.parametrize("scene", SCENES)
async def test_the_one_way_regulation_decides_whether_bicycles_may_ride_both_ways(before_after, scene):
    way_id = list(SCENES).index(scene) + 1
    assert (before_after.before[way_id][0], before_after.after[way_id][0]) == (SCENES[scene].before, SCENES[scene].after)


async def test_a_regulation_on_a_small_part_of_a_way_does_not_decide_its_direction(before_after):
    assert before_after.after[PARTIAL_WAY][0] == before_after.before[PARTIAL_WAY][0] == "forward"


async def test_the_regulation_does_not_change_which_ways_are_one_side_of_a_divided_road(before_after):
    assert {way_id: before_after.after[way_id][1] for way_id in DIVIDED_WAYS} == dict.fromkeys(DIVIDED_WAYS, True)
    assert {way_id: divided for way_id, (_direction, divided) in before_after.after.items()} == {
        way_id: divided for way_id, (_direction, divided) in before_after.before.items()}
