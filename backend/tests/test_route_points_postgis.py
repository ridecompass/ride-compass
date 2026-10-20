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

from app.batch import derive_nodes, derive_stop_places, derive_topology
from app.domain.accident import PartyType
from app.domain.geo import KM_PER_DEGREE_LATITUDE
from app.domain.graph import LeanEdge, edge_key
from app.domain.tuning import TUNING_PARAMETERS_BY_ID
from app.infrastructure.source_models import PARTY_TYPE_CODES
from tests.conftest import empty_ingested_tables
from tests.source_ingest import WAY_ORIGIN, WAY_STEP, ingest_records, point_record, way_record

pytestmark = pytest.mark.asyncio(loop_scope="module")

LON, LAT = WAY_ORIGIN


def _at(along: float, north_m: float) -> tuple[float, float]:
    """道10の西端から`along`（道10の長さに対する割合）だけ東、`north_m`だけ北の点。"""
    return (LON + 2 * WAY_STEP * along, LAT + north_m / (KM_PER_DEGREE_LATITUDE * 1000.0))


def _place(key: int, position: tuple[float, float], name: str, hierarchy: tuple[str, ...]):
    return point_record(key, *position, {
        "names": {"primary": name}, "confidence": 0.75,
        "brand": {"names": {"primary": None}}, "taxonomy": {"hierarchy": list(hierarchy)}})


def _accident(key: int, position: tuple[float, float], *, fatal: bool = False, year: str = "2021"):
    return point_record(key, *position, {
        "当事者種別（当事者A）": PARTY_TYPE_CODES[PartyType.BICYCLE], "当事者種別（当事者B）": "03",
        "死者数": "001" if fatal else "000", "発生日時　　年": year})


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
    await derive_nodes.derive(conn, TUNING_PARAMETERS_BY_ID["signal.match_radius_m"].default)
    await ingest_records("overture_place", [
        _place(1, _at(0.75, -50), "ローソン 渋谷店", ("shopping", "convenience_store")),
        _place(2, _at(0.5, -80), "喫茶A", ("food_and_drink", "cafe")),
        _place(3, _at(0.5, -150), "喫茶B", ("food_and_drink", "cafe")),
    ], conn=conn)
    await derive_stop_places.derive(conn)
    await ingest_records("accident", [
        _accident(1, _at(0.25, 10), fatal=True),
        # 道10から25m、道20から15m
        _accident(2, _at(0.75, 25)),
        _accident(3, _at(0.5, -35)),
    ], conn=conn)


def _edge(way: int) -> LeanEdge:
    return LeanEdge(edge_id=edge_key(way, 0, True), from_node_id="", to_node_id="", geometry=[],
                    distance_m=0.0, osm_way_id=way, segment_index=0, forward=True)


async def test_points_near_each_segment_follow_the_rule_of_their_kind(side_points_world, road_graph_repository):
    """道の上の停止要因・道から100m以内の補給と立ち寄り先・最も近い区間が30m以内の事故だけを、その区間の点にする。
    外れると、グラフに通らない所の点が並ぶか、通る所の点が抜ける。"""
    found = await road_graph_repository.get_route_side_points([_edge(10), _edge(20)])

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


async def test_a_side_point_carries_its_distance_from_the_road(side_points_world, road_graph_repository):
    """続けて走る区間のどちらにも近い点は、道から近い方に置く（`test_route_points.py`）ので、道からの距離は地上のmで要る。"""
    found = await road_graph_repository.get_route_side_points([_edge(10)])

    [toilets] = [hit for hit in found[(10, 0)] if hit.properties.get("kind") == "toilets"]
    assert toilets.distance_m == pytest.approx(55.0, abs=1.0)
