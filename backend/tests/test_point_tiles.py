"""点のタイル（`infrastructure/point_tile_layers.py: POINT_TILE_LAYERS`）が焼く中身。

レイヤーのSQLを読み出しの口（`RoadGraphRepository.get_tile_mvt`）で流し、タイルに出る点を見る。生データは取込の
入口（`tests/source_ingest.py: ingest_records`）から入れ、POIの種別は派生の段（`derive_nodes`）を本物のまま
流して付ける。

ここで見ないもの:
- 取り込んだ範囲の判定そのもの（どのrunの範囲か・範囲の境目） → `test_ingested_area.py`
- タグから種別への引き当て・信号とみなす半径 → `test_derive_nodes.py`
- 宣言どうしの関係（一次属性の指す系統・世代・source-layer名の重なり） → `test_point_tile_layers.py`
- 配信（キャッシュ・空タイル・DB障害・未知のレイヤー） → `test_region_service.py`・`test_region_routes.py`
- 範囲の中で点の無いタイルを空のバイト列にすること → `test_road_graph_repository_contracts.py`
- 自転車・死亡の判定の両側（自転車ではない軽車両・死者0） → `test_derive_counts.py`（同じ式で数える）
- 立ち寄り先の群・絞り・まとめ → `test_stop_places.py`

束ねる升目は、タイルの端から升目の幅で測った位置に点を置いて作る（升目の境目にちょうど乗った点は、どちらの升目に入るかが
浮動小数の丸めで決まる）。
"""

from collections import Counter

import json

import mapbox_vector_tile
import pytest

from app.batch import derive_stop_places
from app.domain.map_display import (
    POINT_CLUSTER_CELLS_PER_TILE,
    POINT_COUNT_PROPERTY,
    POINT_MEMBERS_PROPERTY,
)
from app.domain.region import ROAD_TILE_MAX_ZOOM, BoundingBox, tile_bounds_lonlat, tile_position, tiles_covering_bbox
from app.domain.tuning import STOP_CLUSTER_DISTANCE_ID
from app.infrastructure import derived_data_meta
from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS
from app.infrastructure.road_graph_repository import RoadGraphRepository
from tests.conftest import raw_connection
from tests.source_ingest import (
    accident_record,
    derive_nodes_at_default_radius,
    ingest_records,
    overture_place_record,
    point_record,
)

pytestmark = pytest.mark.asyncio(loop_scope="module")

Z = 16
[(X, Y)] = tiles_covering_bbox(
    BoundingBox(min_latitude=35.6501, min_longitude=139.7001, max_latitude=35.6502, max_longitude=139.7002), Z)
TILE = tile_bounds_lonlat(Z, X, Y)
#: 束ねる升目1つの幅（経度）。
CELL = (TILE.max_longitude - TILE.min_longitude) / POINT_CLUSTER_CELLS_PER_TILE
#: タイルの真ん中の升目の中の点。経度・緯度とも升目の境目から升目の幅の1/4ずつ離す（緯度の升目の高さは経度の幅に近い）。
LON = (TILE.min_longitude + TILE.max_longitude) / 2 + CELL / 4
LAT = (TILE.min_latitude + TILE.max_latitude) / 2 + CELL / 4
#: まとめる距離（40m）より十分に近い／遠いずれ（度）。経度0.0001度は約9mで、束ねる升目の幅より狭い。0.002度は約180m。
NEAR = 0.0001
FAR = 0.002
#: タイルを含む取込の範囲（(min_lat, min_lon, max_lat, max_lon)）と、含まない範囲。
COVERING = (35.6, 139.6, 35.7, 139.8)
ELSEWHERE = (34.6, 135.4, 34.7, 135.6)

SIGNAL = {"highway": "traffic_signals"}
CROSSING = {"highway": "crossing"}
STOP = {"highway": "stop"}
GIVE_WAY = {"highway": "give_way"}
BOLLARD = {"barrier": "bollard"}
LEVEL_CROSSING = {"railway": "level_crossing"}
RAIL_FOOT_CROSSING = {"railway": "crossing"}
TOILETS = {"amenity": "toilets"}


async def _ingest_pois(nodes: list[tuple[float, float, dict[str, str]]], road_area=COVERING) -> None:
    """道の取込（範囲の宣言）とノードを取り込み、種別を付ける派生の段を流す。"""
    await ingest_records("osm_way", [], bbox=road_area)
    await ingest_records("osm_node", [point_record(i, lon, lat, tags) for i, (lon, lat, tags) in enumerate(nodes, 1)])
    async with raw_connection() as conn:
        await derive_nodes_at_default_radius(conn)


async def _tile(repository: RoadGraphRepository, name: str, x: int = X, *, z: int = Z, y: int = Y) -> bytes | None:
    layer = POINT_TILE_LAYERS[name]
    return await repository.get_tile_mvt(layer.sql, layer.source_layer, z, x, y, tile_bounds_lonlat(z, x, y))


def _features(tile: bytes | None, name: str) -> list[dict]:
    assert tile is not None
    decoded = mapbox_vector_tile.decode(tile)
    assert list(decoded) == [POINT_TILE_LAYERS[name].source_layer]
    return decoded[POINT_TILE_LAYERS[name].source_layer]["features"]


async def _ingest_stop_places(places: list[object]) -> None:
    """Overture の地点を取り込み、立ち寄り先の表を作る派生の段を流す。"""
    await ingest_records("overture_place", places)
    async with raw_connection() as conn:
        await derive_stop_places.derive(conn)


def _kinds(tile: bytes | None) -> Counter[str]:
    return Counter(f["properties"]["kind"] for f in _features(tile, "poi"))


# --- POI ---------------------------------------------------------------------


async def test_a_poi_tile_outside_the_imported_roads_is_not_baked(road_graph_repository):
    """道を取り込んでいない所の点は、範囲の外として空タイルへ回る（一部だけ取得済みの範囲で、無いと誤読させない）。"""
    await _ingest_pois([(LON, LAT, STOP)], road_area=ELSEWHERE)

    assert await _tile(road_graph_repository, "poi") is None


async def test_each_poi_is_a_point_named_by_its_kind(road_graph_repository):
    await _ingest_pois([
        (LON, LAT, SIGNAL),
        (LON + FAR, LAT, CROSSING),
        (LON - FAR, LAT, STOP),
        (LON, LAT + FAR, TOILETS),
        (LON, LAT - FAR, {"name": "種別の付かないノード"}),
    ])

    assert _kinds(await _tile(road_graph_repository, "poi")) == Counter(
        {"traffic_signals": 1, "crossing": 1, "stop": 1, "toilets": 1})


async def test_a_crossing_beside_a_signal_is_drawn_as_the_signal(road_graph_repository):
    """信号の付いた交差点の横断歩道は信号として数えるので、地図でも信号の点に入る。"""
    await _ingest_pois([(LON, LAT, SIGNAL), (LON + NEAR, LAT, CROSSING)])

    assert _kinds(await _tile(road_graph_repository, "poi")) == Counter({"traffic_signals": 1})


async def test_nearby_stop_pois_merge_only_within_the_same_legend_row(road_graph_repository):
    """凡例の同じ行（車道の踏切と歩道の踏切）は見分けられないので1点、別の行（一時停止と徐行）は近くても別の点。"""
    await _ingest_pois([
        (LON, LAT, LEVEL_CROSSING),
        (LON + NEAR, LAT, RAIL_FOOT_CROSSING),
        (LON + FAR, LAT, STOP),
        (LON + FAR + NEAR, LAT, GIVE_WAY),
    ])

    assert _kinds(await _tile(road_graph_repository, "poi")) == Counter(
        {"level_crossing": 1, "stop": 1, "give_way": 1})


async def test_stop_pois_merge_within_the_distance_the_counts_were_built_with(road_graph_repository):
    """停止の点は、管理画面の今の上書きではなく、派生を作り直したときのまとめる距離でまとめる。地図の点の数が、停止回数として
    数えた数と食い違わない。"""
    await _ingest_pois([(LON, LAT, BOLLARD), (LON + CELL, LAT, BOLLARD)])
    async with raw_connection() as conn:
        await derived_data_meta.replace_tuning(conn, {STOP_CLUSTER_DISTANCE_ID: 5.0})
        try:
            tile = await _tile(road_graph_repository, "poi")
        finally:
            await derived_data_meta.replace_tuning(conn, {})

    assert _kinds(tile) == Counter({"barrier": 2})


async def test_supply_pois_are_not_merged_into_one_place(road_graph_repository):
    """補給の点は別々の実体なので、隣り合っていても1つの所にまとめない（升目が違えば別の点のまま）。"""
    await _ingest_pois([(LON, LAT, TOILETS), (LON + CELL, LAT, TOILETS)])

    assert _kinds(await _tile(road_graph_repository, "poi")) == Counter({"toilets": 2})


async def test_points_of_the_same_legend_row_in_one_cell_become_one_point_counting_them(road_graph_repository):
    """同じ升目の同じ行の点は、束ねた点の1つの位置に1点だけ描き、数と、名前のある点の名前と位置を名前の順に持つ。
    押すと、中の店を1行ずつ並べられる。"""
    first, second = (LON + CELL / 4, LAT), (LON, LAT + CELL / 4)
    await _ingest_stop_places([
        overture_place_record(1, *first, "店B"),
        overture_place_record(2, *second, "店A"),
    ])

    [feature] = _features(await _tile(road_graph_repository, "stop_place"), "stop_place")

    props = feature["properties"]
    assert props[POINT_COUNT_PROPERTY] == 2
    assert props["name"] in {"店A", "店B"}
    assert json.loads(props[POINT_MEMBERS_PROPERTY]) == [
        ["店A", pytest.approx(second[0], abs=1e-6), pytest.approx(second[1], abs=1e-6)],
        ["店B", pytest.approx(first[0], abs=1e-6), pytest.approx(first[1], abs=1e-6)],
    ]


async def test_points_of_different_legend_rows_in_one_cell_stay_apart(road_graph_repository):
    """凡例で行を隠したときに、ほかの行の点ごと消えない。"""
    await ingest_records("accident", [
        accident_record(1, LON, LAT, party_a="51"),
        accident_record(2, LON + CELL / 4, LAT, fatal=True),
    ])

    features = _features(await _tile(road_graph_repository, "accident"), "accident")

    assert sorted((f["properties"]["fatal"], f["properties"][POINT_COUNT_PROPERTY]) for f in features) == [
        (False, 1), (True, 1)]


async def test_the_most_zoomed_tile_is_cut_into_cells_as_wide_as_the_zoomed_out_ones(road_graph_repository):
    """一番寄った縮尺のタイルも、引いた縮尺と同じ数の升目で束ねる。それより寄った地図はこのタイルを引き伸ばして描くので、
    升目が細かいと隣り合う升目の代表点の絵が重なって描かれる。"""
    x, y = (int(i) for i in tile_position(LON, LAT, ROAD_TILE_MAX_ZOOM))
    tile = tile_bounds_lonlat(ROAD_TILE_MAX_ZOOM, x, y)
    width = (tile.max_longitude - tile.min_longitude) / POINT_CLUSTER_CELLS_PER_TILE
    lat = tile.min_latitude + width / 4
    await ingest_records("accident", [
        accident_record(1, tile.min_longitude + width / 4, lat),
        accident_record(2, tile.min_longitude + width * 3 / 4, lat),
    ])

    [merged] = _features(await _tile(road_graph_repository, "accident", x, z=ROAD_TILE_MAX_ZOOM, y=y), "accident")

    assert merged["properties"][POINT_COUNT_PROPERTY] == 2


async def test_convenience_stores_come_from_the_stop_places_with_their_names_and_not_from_openstreetmap(
    road_graph_repository,
):
    """補給の点のコンビニは立ち寄り先の群「コンビニ」の行から出し、OpenStreetMap の`shop=convenience`は出さない。
    ほかの群の立ち寄り先は補給の点に出ない。コンビニは押すと店の名前で外の地図を開けるように名前を持ち、
    OpenStreetMap の点は名前を焼かない。"""
    await _ingest_pois([(LON, LAT, {"shop": "convenience"}), (LON + FAR, LAT, {**TOILETS, "name": "公園のトイレ"})])
    await _ingest_stop_places([
        overture_place_record(1, LON - FAR, LAT, "ローソン 渋谷店", ("shopping", "convenience_store")),
        overture_place_record(2, LON, LAT + FAR, "店2"),
    ])

    features = _features(await _tile(road_graph_repository, "poi"), "poi")

    assert sorted((f["properties"]["kind"], f["properties"].get("name")) for f in features) == [
        ("convenience", "ローソン 渋谷店"), ("toilets", None)]


async def test_a_merged_point_on_a_tile_edge_is_drawn_once(road_graph_repository):
    """タイルの境目をまたぐ塊は、両側のタイルで別々の点にならず、真ん中が入るタイルにだけ1点出る。
    まとめない点は、それぞれ自分の入るタイルにだけ出る。"""
    edge = TILE.max_longitude
    await _ingest_pois([
        (edge - NEAR / 2, LAT, BOLLARD),
        (edge + NEAR * 1.5, LAT, BOLLARD),
        (edge - NEAR / 2, LAT + FAR, TOILETS),
        (edge + NEAR / 2, LAT + FAR, TOILETS),
    ])

    assert _kinds(await _tile(road_graph_repository, "poi")) == Counter({"toilets": 1})
    assert _kinds(await _tile(road_graph_repository, "poi", X + 1)) == Counter({"barrier": 1, "toilets": 1})


# --- 事故 --------------------------------------------------------------------


async def test_accident_tiles_do_not_depend_on_the_imported_roads(road_graph_repository):
    """事故は対象範囲を一括で取り込むので、道を取り込んでいない所でも範囲の外にしない。タイルの外の事故は出ない。"""
    await ingest_records("accident", [accident_record(1, LON, LAT), accident_record(2, LON + 10 * FAR, LAT)])

    assert len(_features(await _tile(road_graph_repository, "accident"), "accident")) == 1


@pytest.mark.parametrize(
    ("record", "expected"),
    [
        (dict(party_a="51"), dict(involves_bicycle=True, fatal=False)),
        (dict(party_b="52"), dict(involves_bicycle=True, fatal=False)),
        (dict(fatal=True), dict(involves_bicycle=False, fatal=True)),
    ],
    ids=["bicycle_as_party_a", "e_bike_as_party_b", "fatal"],
)
async def test_an_accident_point_carries_bicycle_fatal_and_year(road_graph_repository, record, expected):
    await ingest_records("accident", [accident_record(1, LON, LAT, year=2021, **record)])

    [feature] = _features(await _tile(road_graph_repository, "accident"), "accident")

    assert feature["properties"] == {**expected, "occurred_year": 2021, POINT_COUNT_PROPERTY: 1}


# --- 立ち寄り先 ----------------------------------------------------------------


async def test_a_stop_place_point_carries_its_group_and_name(road_graph_repository):
    """立ち寄り先は事故と同じく対象範囲を一括で取り込むので、道を取り込んでいない所でも出す。タイルの外の地点と、
    補給の点に出す群「コンビニ」は出ない。"""
    await _ingest_stop_places([
        overture_place_record(1, LON, LAT, "店1"),
        overture_place_record(2, LON + 10 * FAR, LAT, "店2"),
        overture_place_record(3, LON + FAR, LAT, "ローソン 渋谷店", ("shopping", "convenience_store")),
    ])

    [feature] = _features(await _tile(road_graph_repository, "stop_place"), "stop_place")

    assert feature["properties"] == {"group": "eat_drink", "name": "店1", POINT_COUNT_PROPERTY: 1}
