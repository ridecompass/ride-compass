"""`infrastructure/road_graph_repository.py: RoadGraphRepository.get_route_side_points`——区間ごとに、近くの点を
区間の形の上の位置つきで引くこと。

見るもの: 点の一次属性ごとの近さの規則（停止要因は道の上・補給と立ち寄り先は道から100m以内・事故は最も近い区間が
30m以内）と、点に添える値。
ここで見ないもの:
- 経路の上で通る距離へ並べること・近い点をまとめること → `test_route_points.py`
- 応答の候補へ点が載ること → `test_route_generation_behavior.py`
- タグから種別・立ち寄り先の群への引き当て → `test_derive_nodes.py`・`test_stop_places.py`

道10は東西にまっすぐ延びる1区間（ノード1〜3。途中のノード2は交差点ではないので区間を切らない）で、道20は
道10の北40mに並ぶ別の1区間。
"""

import pytest
import pytest_asyncio

from app.batch import derive_stop_places, derive_topology
from app.domain.accident import PartyType
from app.domain.geo import KM_PER_DEGREE_LATITUDE
from app.domain.tuning import ACCIDENT_MATCH_DISTANCE_ID, STOP_CLUSTER_DISTANCE_ID
from app.infrastructure import derived_data_meta
from app.infrastructure.source_models import PARTY_TYPE_CODES
from tests.conftest import empty_ingested_tables
from tests.source_ingest import (
    WAY_ORIGIN,
    WAY_STEP,
    accident_record,
    derive_nodes_at_default_radius,
    ingest_records,
    overture_place_record,
    point_record,
    way_record,
)

pytestmark = pytest.mark.asyncio(loop_scope="module")

LON, LAT = WAY_ORIGIN


def _at(along: float, north_m: float) -> tuple[float, float]:
    """道10の西端から`along`（道10の長さに対する割合）だけ東、`north_m`だけ北の点。"""
    return (LON + 2 * WAY_STEP * along, LAT + north_m / (KM_PER_DEGREE_LATITUDE * 1000.0))


def _accident(key: int, position: tuple[float, float], *, fatal: bool = False):
    """2021年の、自転車が当事者Aの事故。"""
    return accident_record(key, *position, party_a=PARTY_TYPE_CODES[PartyType.BICYCLE], fatal=fatal, year=2021)


@pytest_asyncio.fixture(loop_scope="module")
async def side_points_world(derive_conn):
    """テストごとに同じ生データから作り直す（`derive_conn`はファイルの前後でしか空にしない）。"""
    conn = derive_conn
    await empty_ingested_tables(conn)
    await ingest_records("osm_way", [
        way_record(10, [_at(0, 0), _at(0.5, 0), _at(1, 0)], [1, 2, 3]),
        way_record(20, [_at(0, 40), _at(1, 40)], [4, 5]),
    ], conn=conn)
    await derive_topology.derive(conn)
    await ingest_records("osm_node", [
        point_record(2, *_at(0.5, 0), {"highway": "stop"}),
        point_record(101, *_at(0.5, -5), {"highway": "stop"}),
        point_record(102, *_at(0.25, -55), {"amenity": "toilets"}),
        point_record(103, *_at(0.25, -120), {"amenity": "toilets"}),
    ], conn=conn)
    await derive_nodes_at_default_radius(conn)
    await ingest_records("overture_place", [
        overture_place_record(1, *_at(0.75, -50), "ローソン 渋谷店", ("shopping", "convenience_store")),
        overture_place_record(2, *_at(0.5, -80), "喫茶A"),
        overture_place_record(3, *_at(0.5, -150), "喫茶B"),
    ], conn=conn)
    await derive_stop_places.derive(conn)
    await ingest_records("accident", [
        _accident(1, _at(0.25, 10), fatal=True),
        # 道10から25m、道20から15m
        _accident(2, _at(0.75, 25)),
        _accident(3, _at(0.5, -35)),
    ], conn=conn)


async def test_points_near_each_segment_follow_the_rule_of_their_kind(side_points_world, road_graph_repository):
    """道の上の停止要因・道から100m以内の補給と立ち寄り先・最も近い区間が30m以内の事故だけを、その区間の点にする。
    外れると、グラフに通らない所の点が並ぶか、通る所の点が抜ける。"""
    found = await road_graph_repository.get_route_side_points([(10, 0), (20, 0)])

    summary = {
        key: sorted((hit.layer, hit.merge_group, tuple(sorted(hit.properties.items())), round(hit.fraction, 2))
                    for hit in hits)
        for key, hits in found.items()
    }
    assert summary == {
        (10, 0): sorted([
            ("stop_poi", "stop", (("kind", "stop"),), 0.5),
            ("supply_poi", None, (("kind", "toilets"),), 0.25),
            ("supply_poi", None, (("kind", "convenience"), ("name", "ローソン 渋谷店")), 0.75),
            ("stop_place", None, (("group", "eat_drink"), ("name", "喫茶A")), 0.5),
            ("accident_point", None, (("fatal", True), ("involves_bicycle", True), ("occurred_year", 2021)), 0.25),
        ]),
        # 補給の2点は道20からも100m以内なので、道20の点にもなる（喫茶Aは道20から120m）。
        (20, 0): sorted([
            ("supply_poi", None, (("kind", "toilets"),), 0.25),
            ("supply_poi", None, (("kind", "convenience"), ("name", "ローソン 渋谷店")), 0.75),
            ("accident_point", None, (("fatal", False), ("involves_bicycle", True), ("occurred_year", 2021)), 0.75),
        ]),
    }


async def test_a_side_point_carries_its_distance_from_the_road_and_its_position(side_points_world, road_graph_repository):
    """続けて走る区間のどちらにも近い点は道から近い方に置き（`test_route_points.py`）、画面は道からの距離を出すので、地上のmで要る。
    画面は点そのものの位置に地図の印を出すので、位置は道の上でなく点の所。"""
    found = await road_graph_repository.get_route_side_points([(10, 0)])

    [toilets] = [hit for hit in found[(10, 0)] if hit.properties.get("kind") == "toilets"]
    assert toilets.distance_m == pytest.approx(55.0, abs=1.0)
    assert (toilets.longitude, toilets.latitude) == pytest.approx(_at(0.25, -55))


async def test_side_points_use_the_values_the_derived_tables_were_built_with(side_points_world, road_graph_repository,
                                                                              derive_conn):
    """事故を道に付ける距離と点をまとめる距離は、管理画面の今の上書きではなく、派生を作り直したときの値で読む。グラフの事故の
    印が、事故の材料として数えた事故と食い違わず、停止の印が地図の点と同じようにまとまる。道10から35mの事故は、付ける距離が
    40mなら道10の点になる。"""
    await derived_data_meta.replace_tuning(derive_conn, {ACCIDENT_MATCH_DISTANCE_ID: 40.0, STOP_CLUSTER_DISTANCE_ID: 15.0})
    try:
        found = await road_graph_repository.get_route_side_points([(10, 0)])
    finally:
        await derived_data_meta.replace_tuning(derive_conn, {})

    assert sorted(round(hit.fraction, 2) for hit in found[(10, 0)] if hit.layer == "accident_point") == [0.25, 0.5]
    assert {hit.merge_within_m for hit in found[(10, 0)]} == {15.0}
