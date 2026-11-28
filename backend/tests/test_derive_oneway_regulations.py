"""JARTIC の一方通行の規制を効かせた道の通行方向（`batch/derive_way_directions.py: derive`が書く`way_directions`）。

同じ道を、規制を取り込む前と後で段に通し、前後を比べる。見るのは、自転車を除く規制が当たる一方通行の道は自転車が両方向に
辿れ、自転車も対象の規制が当たる道は（タグが自転車を除いていても）タグの向きの一方向になり、両方向の道へ一方通行を足さず、
道の一部にだけ当たる規制は効かず、上下線分離の判定は規制で変わらず、線の同じ所に2本の道が並ぶとき自転車を除く規制は
どちらにも効かせず、自転車も対象の規制は両方に効かせ、交差点で切れて縦に続く2本には自転車を除く規制も効かせ、見送った規制の区間を道の長さの割合に数えないこと。

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
    "自転車を除く規制が逆向きの一方通行に当たる": Scene({"oneway": "-1"}, [EXCEPT_BICYCLES], "backward", "both"),
    "自転車を除く規制が、タグが自転車も一方通行の道に当たる": Scene(
        {"oneway": "yes", "oneway:bicycle": "yes"}, [EXCEPT_BICYCLES], "forward", "both"),
}

#: 道の一部にだけ当たる場面。道を横切る道で区間を2つに切り、短い方の区間（道の長さの割合の較正値より短い）にだけ規制を沿わせる。
PARTIAL_WAY = 900
PARTIAL_CUT = LENGTH * TUNING[REGULATION_EDGE_SHARE_ID] * 0.6
#: 見送る規制が全長に当たる場面。道（`SKIPPED_WAY`）に並べた道とで共有になる自転車を除く規制を全長に沿わせ、横切る道で切った
#: 短い方の区間にだけ、並べた道から帯の外になる側に、別の自転車を除く規制を沿わせる。
SKIPPED_WAY = 960
#: 道の一部にだけ沿う規制の線を道より南へ置くための、線の点のずらし幅（緯度。線は道の約10m 南で、道は帯に入り、北に並べた道は帯の外）。
SOUTH_SHIFT = 3 * OFFSET
#: 上下線の場面。同じ名前の対向一方通行を名前の距離の内側に並べ、規制は片側に沿わせる。
DIVIDED_WAYS = (910, 920)
#: 並ぶ2本の道（同じ向きの一方通行）の間隔。2本とも規制の線の帯に入る。
PARALLEL_GAP = 0.00007


class Pair(NamedTuple):
    """1本の規制が沿う2本の道（`side_by_side`なら並べ、偽なら交差点で切れて縦に続く）と、2本のタグと、規制の条件の組と、
    規制の前後の通行方向（2本とも同じ）。"""

    ways: tuple[int, int]
    side_by_side: bool
    tags: dict[str, str]
    regulation: dict[str, str]
    before: str
    after: str


PAIRS: dict[str, Pair] = {
    "自転車を除く規制は、並ぶ2本のどちらの道の規制か決められないので効かせない": Pair(
        (930, 931), True, {"oneway": "yes"}, EXCEPT_BICYCLES, "forward", "forward"),
    "自転車も対象の規制は、並ぶ2本のどちらにも効かせる": Pair(
        (940, 941), True, {"oneway": "yes", "oneway:bicycle": "no"}, ALL_VEHICLES, "both", "forward"),
    "自転車を除く規制は、交差点で切れて縦に続く2本のどちらにも効かせる": Pair(
        (950, 951), False, {"oneway": "yes"}, EXCEPT_BICYCLES, "forward", "both"),
}


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
    for k, pair in enumerate(PAIRS.values()):
        (west, lat), (east, _) = _east(partial + 2 + k)
        first, second = pair.ways
        tags = {"highway": "residential", **pair.tags}
        if pair.side_by_side:
            ways += [way_record(first, [(west, lat), (east, lat)], [first * 10, first * 10 + 1], tags),
                     way_record(second, [(west, lat + PARALLEL_GAP), (east, lat + PARALLEL_GAP)], [second * 10, second * 10 + 1], tags)]
        else:
            middle = (west + east) / 2
            ways += [way_record(first, [(west, lat), (middle, lat)], [first * 10, first * 10 + 1], tags),
                     way_record(second, [(middle, lat), (east, lat)], [first * 10 + 1, second * 10 + 1], tags)]
    (west, lat), (east, _) = _east(partial + 2 + len(PAIRS))
    one_way = {"highway": "residential", "oneway": "yes"}
    ways += [
        way_record(SKIPPED_WAY, [(west, lat), (west + PARTIAL_CUT, lat), (east, lat)], [9600, 9601, 9602], one_way),
        way_record(SKIPPED_WAY + 1, [(west, lat + PARALLEL_GAP), (east, lat + PARALLEL_GAP)], [9610, 9611], one_way),
        way_record(SKIPPED_WAY + 2, [(west + PARTIAL_CUT, lat), (west + PARTIAL_CUT, lat - 0.001)], [9601, 9603],
                   {"highway": "residential"}),
    ]
    return ways


def _regulations() -> list[SourceRecord]:
    regulations = [_regulation(f"{i}-{k}", _east(i), attrs)
                   for i, scene in enumerate(SCENES.values()) for k, attrs in enumerate(scene.regulations)]
    partial = len(SCENES)
    regulations.append(_regulation("partial", [(BASE_LON, _lat(partial)), (BASE_LON + PARTIAL_CUT, _lat(partial))],
                                   EXCEPT_BICYCLES))
    regulations.append(_regulation("divided", _east(partial + 1), EXCEPT_BICYCLES))
    regulations += [_regulation(f"pair-{k}", _east(partial + 2 + k), pair.regulation) for k, pair in enumerate(PAIRS.values())]
    (west, lat), _ = line = _east(partial + 2 + len(PAIRS))
    regulations += [_regulation("skipped-whole", line, EXCEPT_BICYCLES),
                    _regulation("skipped-part", [(west, lat - SOUTH_SHIFT), (west + PARTIAL_CUT, lat - SOUTH_SHIFT)], EXCEPT_BICYCLES)]
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


@pytest.mark.parametrize("pair", PAIRS)
async def test_a_regulation_excepting_bicycles_reaches_two_ways_only_when_they_continue_one_another(before_after, pair):
    ways = PAIRS[pair].ways
    assert ({w: before_after.before[w][0] for w in ways}, {w: before_after.after[w][0] for w in ways}) == (
        dict.fromkeys(ways, PAIRS[pair].before), dict.fromkeys(ways, PAIRS[pair].after))


async def test_a_skipped_regulation_does_not_count_toward_the_share_another_regulation_needs(before_after):
    assert before_after.after[SKIPPED_WAY][0] == before_after.before[SKIPPED_WAY][0] == "forward"
