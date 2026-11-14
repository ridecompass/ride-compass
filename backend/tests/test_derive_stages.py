"""派生の作り直し（`batch/derive_cli.py`）が、選んだ段と、その出力を読む後ろの段だけを流し、その段の表だけを作業用の
スキーマに作ることと、段を選ばなければ全部の段を流すことと、作り直しの記録（作った取込・較正値）を流した段の分だけ今の値に
することと、段の宣言（`STAGES`）が段の読むもの・書くものを漏らしていないことと、段の書いた表が統計を持つこと。

流した段は段の関数が呼ばれたかで見る。どの生データにも行があり、どの段も値を書く小さな世界（道2本・信号・事故・標高と
土地被覆のタイル・住所・小地域の境界・地点・寺社の建物・道を囲む交通規制）から始める。

ここで見ないもの: 入れ替えまで読み手に前の表を見せること・取込の記録・較正値の読み方 → `test_derive_cli.py`。
段の値の出し方 → 段ごとのテスト（`test_derive_*.py`）。
"""

import functools
from dataclasses import dataclass, field

import asyncpg
import pytest
import pytest_asyncio
import shapely
from shapely.geometry import box

from app.batch import derive_cli
from app.batch.dem_tile_store import PRODUCT_PRIORITY
from app.batch.ingest import SourceRecord
from app.batch.source_adapters.npa_honhyo import HonhyoRows
from app.batch.source_adapters.raster_wkb import tile_raster_wkb
from app.domain.accident import PartyType
from app.domain.landcover import PERCENT_CLASSES
from app.domain.region import BoundingBox
from app.domain.tuning import LANDCOVER_RING_OUTER_ID
from app.infrastructure import derived_data_meta, road_network_store
from app.infrastructure.derived_data_freshness import derived_tables
from app.infrastructure.source_models import PARTY_TYPE_CODES, PEDESTRIAN_ROAD_KIND, Source
from tests.conftest import (
    empty_ingested_tables,
    override_tuning,
    postgis_database_url,
    raw_connection,
    reset_derived_revision,
)
from tests.tuning_fixture import TUNING
from tests.source_ingest import (
    abr_block_record,
    accident_record,
    abr_city_record,
    abr_prefecture_record,
    abr_town_record,
    dem_tile_records,
    estat_small_area_record,
    ingest_records,
    isj_block_record,
    overture_place_record,
    point_record,
    tile_record,
    zigzag_point,
    zigzag_way_record,
)

pytestmark = pytest.mark.asyncio(loop_scope="module")

#: 道とノードは土地被覆のタイル（ズーム14の1枚。約2km四方）の中ほどに置く。区間の帯（中心線から100m）もこの1枚に収まる。
BASE_LON, BASE_LAT = 139.688, 35.683
STEP = 0.0005
LULC_ZOOM, LULC_X, LULC_Y, LULC_SIZE = 14, 14549, 6451, 256
WAYS = ((100, [1, 2, 3]), (200, [3, 4]))
SHINJUKU = ("東京都", "新宿区", "")
SIGNAL_RADIUS = "signal.match_radius_m"
#: テストが上書きする較正値。`world`の片付けで上書きを消す。
OVERRIDDEN = (SIGNAL_RADIUS, LANDCOVER_RING_OUTER_ID)
STAGE_NAMES = list(derive_cli.STAGE_NAMES)


def _point(node_id: int) -> tuple[float, float]:
    return zigzag_point(node_id, (BASE_LON, BASE_LAT), STEP)


async def _ingest_ways(conn: asyncpg.Connection) -> None:
    await ingest_records("osm_way", [
        zigzag_way_record(way_id, nodes, {"highway": "residential"}, origin=(BASE_LON, BASE_LAT), step=STEP)
        for way_id, nodes in WAYS], conn=conn)


async def _ingest_nodes(conn: asyncpg.Connection) -> None:
    await ingest_records("osm_node", [point_record(n, *_point(n), {"highway": "traffic_signals"} if n == 2 else None)
                                      for n in range(1, 5)], conn=conn)


async def _ingest_accidents(conn: asyncpg.Connection) -> int:
    return await ingest_records("accident", [
        accident_record("on-way-100", *_point(2), party_a=PARTY_TYPE_CODES[PartyType.BICYCLE], party_b="59")],
        conn=conn, rows=HonhyoRows(years=[2024]))


@functools.cache
def _elevation_records() -> list[SourceRecord]:
    """画素ごとに標高を求めるので、`world`を作るたびに作り直さない。"""
    area = BoundingBox(min_latitude=BASE_LAT - 0.001, min_longitude=BASE_LON,
                       max_latitude=BASE_LAT + 0.002, max_longitude=BASE_LON + 0.003)
    return dem_tile_records(PRODUCT_PRIORITY[0], 15, area, lambda lon, lat: 10 + (lon - BASE_LON) * 1000)


async def _ingest_elevations(conn: asyncpg.Connection) -> None:
    await ingest_records("dem", _elevation_records(), conn=conn)


async def _ingest_landcover(conn: asyncpg.Connection) -> int:
    return await ingest_records("lulc", [tile_record(
        "tile", LULC_ZOOM, LULC_X, LULC_Y,
        tile_raster_wkb(bytes([PERCENT_CLASSES[0][1]]) * LULC_SIZE ** 2, zoom=LULC_ZOOM, x=LULC_X, y=LULC_Y,
                        width=LULC_SIZE, height=LULC_SIZE, dtype="uint8", nodata=0),
        {"z": LULC_ZOOM, "x": LULC_X, "y": LULC_Y, "width": LULC_SIZE})], conn=conn)


async def _ingest_addresses(conn: asyncpg.Connection) -> None:
    town = abr_town_record("131041", "0024000", "1", SHINJUKU, *_point(2), oaza="西新宿")
    await ingest_records("abr", [
        abr_prefecture_record("130001", "東京都", *_point(1)),
        abr_city_record("131041", "東京都", "新宿区", *_point(1)),
        town,
        abr_block_record(town, "008", "8", *_point(2)),
    ], conn=conn)
    # 地番は住居表示の区域（ABR の街区を持つ区画）には入らないが、住所の段が読むことは数に出る。
    await ingest_records("isj_block", [isj_block_record("東京都", "新宿区", "西新宿", "1", *_point(2))], conn=conn)


async def _ingest_places(conn: asyncpg.Connection) -> None:
    await ingest_records("overture_place", [overture_place_record("cafe", *_point(2), "喫茶店")], conn=conn)


@pytest_asyncio.fixture(loop_scope="module")
async def world(road_graph_engine, road_network_root):
    """どの生データにも行がある世界を取り込み、全部の段を流して作り直した後の接続。道路網の置き場は一時ディレクトリ。

    `road_graph_engine`に依存するのはスキーマを作らせるため。
    """
    async with raw_connection() as conn:
        await empty_ingested_tables(conn)
        try:
            await _ingest_ways(conn)
            await _ingest_nodes(conn)
            await _ingest_accidents(conn)
            await _ingest_elevations(conn)
            await _ingest_landcover(conn)
            await _ingest_addresses(conn)
            west, south = _point(1)
            await ingest_records("estat_small_area", [estat_small_area_record("13104002400", "新宿区", "西新宿", [
                (west, south - 0.001), (west, south + 0.002), (west + 0.003, south + 0.002),
                (west + 0.003, south - 0.001), (west, south - 0.001)])], conn=conn)
            await _ingest_places(conn)
            await ingest_records("jartic_regulation", [SourceRecord(
                natural_key="regulation", geom_wkb=shapely.to_wkb(box(west - 0.01, south - 0.01, west + 0.01, south + 0.01)),
                attrs={"共通規制種別コード": PEDESTRIAN_ROAD_KIND, "点・線・面コード": "3"})], conn=conn)
            await ingest_records("bunka_heritage", [point_record("bunka-1", *_point(3), {"bunka-14-s": "宗教法人神田神社"})],
                                 conn=conn)
            assert await derive_cli.run(postgis_database_url()) == 0
            yield conn
        finally:
            for param_id in OVERRIDDEN:
                await override_tuning(param_id, TUNING[param_id])
            await empty_ingested_tables(conn)
            await reset_derived_revision(conn)


@dataclass
class Ran:
    """`world`を作った後の作り直しで、関数が呼ばれた段の名前（呼ばれた順）と、そのとき作業用のスキーマにあった表。"""

    stages: list[str] = field(default_factory=list)
    work_tables: set[str] = field(default_factory=set)


@pytest.fixture
def ran(world, monkeypatch) -> Ran:
    """段の関数が呼ばれるたびに`Ran`へ書く。段そのものは本物を通す。

    段が受ける接続は作業用のスキーマを`search_path`の先頭に置くので、`current_schema()`がそのスキーマを指す。
    """
    seen = Ran()
    for stage in derive_cli.STAGES:
        async def derive(conn, *, _real=stage.module.derive, _name=stage.name, **tuning):
            seen.stages.append(_name)
            seen.work_tables.update(row["table_name"] for row in await conn.fetch(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()"))
            return await _real(conn, **tuning)

        monkeypatch.setattr(stage.module, "derive", derive)
    return seen


async def _values(conn: asyncpg.Connection) -> dict[str, str]:
    """派生の表ごとの、全部の行と値のハッシュ。"""
    return {table.name: await conn.fetchval(
        f"SELECT md5(coalesce(string_agg(r::text, '|' ORDER BY r::text), '')) FROM {table.name} r")  # 宣言のみ
        for table in derived_tables()}


async def _revision(conn: asyncpg.Connection) -> int:
    return await conn.fetchval("SELECT revision FROM derived_data_meta")


async def test_the_world_fills_every_derived_table_and_each_has_statistics(world):
    """前提: 比べる表はどれも行を持ち、流さなかった段の値が空の表どうしの比べにならない。

    段が書いた表は、作り直しの後に統計（`pg_stats`）を持つ——無いまま配信と後ろの段が読むと、実行計画が桁で外れる。
    統計を書くのは`ANALYZE`だけで、表を作り直すたびに消える（作業用のスキーマに新しく作る）。"""
    assert {table.name: await world.fetchval(f"SELECT count(*) > 0 FROM {table.name}")  # 宣言のみ
            for table in derived_tables()} == {table.name: True for table in derived_tables()}
    tables = [table for stage in derive_cli.STAGES for table in stage.tables]
    assert {table: await world.fetchval(
        "SELECT count(*) > 0 FROM pg_stats WHERE schemaname = 'public' AND tablename = $1", table)
        for table in tables} == dict.fromkeys(tables, True)


@pytest.mark.parametrize(("chosen", "expected"), [
    (None, STAGE_NAMES),
    (["elevation"], ["elevation"]),
    (["nodes"], ["nodes", "counts"]),
    (["topology"], ["topology", "nodes", "counts", "elevation", "landcover", "traffic_regulations", "directions"]),
    (["places", "elevation"], ["elevation", "places"]),
    ([derive_cli.NETWORK], []),
], ids=["選ばない", "後ろの段の無い段", "数の段が読む段", "区間を切る段", "2つの段", "道路網の配列だけ"])
async def test_choosing_stages_adds_the_stages_that_read_them(chosen, expected):
    """選んだ段に、その出力を読む後ろの段（たどった先も）を足して段の順に並べる。選ばなければ全部の段。"""
    assert [stage.name for stage in derive_cli.stages_to_run(chosen)] == expected


async def test_an_unknown_stage_is_refused():
    """知らない段の名前は、何も流す前に断る。"""
    with pytest.raises(ValueError, match="知らない段"):
        derive_cli.stages_to_run(["elevations"])


#: 派生の表と一緒に作業用のスキーマで書き、入れ替える記録の表。
RECORDS = set(derived_data_meta.RECORD_TABLES)


async def test_a_partial_rebuild_runs_only_the_chosen_stages_and_records_only_what_they_read(world, ran):
    """交差点の段を選ぶと、それを読む数の段と一緒に流し、作業用のスキーマにはその表と記録の表だけを作る。流さなかった段の表は
    前の値のまま残り、道路網の配列は世代を進めて作る。記録は、使う段が全部流れた取込・較正値だけを今の値にする——取り直した
    事故（数の段が読む）と変えた信号の半径（交差点の段）は入り、取り直した土地被覆と変えた帯の幅（土地被覆の段）は前回のまま
    （流さなかった段の表は前回の取込と較正値で作ったままで、記録を読む所（鮮度の台帳・事故密度の分母等）が表と食い違わない）。"""
    values, revision = await _values(world), await _revision(world)
    before = await derived_data_meta.read_records(world)
    accident = await _ingest_accidents(world)
    await _ingest_landcover(world)
    await override_tuning(SIGNAL_RADIUS, 150.0)
    await override_tuning(LANDCOVER_RING_OUTER_ID, 50.0)
    written = {"node_kinds", "node_turns", "edge_counts", "way_counts"}

    assert await derive_cli.run(postgis_database_url(), ["nodes"]) == 0

    assert ran.stages == ["nodes", "counts"]
    assert ran.work_tables == written | RECORDS
    after = await _values(world)
    assert {table: after[table] for table in after if table not in written} == {
        table: values[table] for table in values if table not in written}
    assert road_network_store.current().revision == revision + 1
    records = await derived_data_meta.read_records(world)
    assert (records.runs[Source.ACCIDENT], records.tuning[SIGNAL_RADIUS]) == (accident, 150.0)
    assert (records.runs[Source.LULC], records.tuning[LANDCOVER_RING_OUTER_ID]) == (
        before.runs[Source.LULC], before.tuning[LANDCOVER_RING_OUTER_ID])


@dataclass
class Touched:
    """段1回が触ったもの。"""

    #: 読んだソース（パーティションを読んだもの）。
    sources: set[str]
    #: 読んだ派生の表（書いた表も、書くときに読む）。
    read: set[str]
    #: 書いた派生の表。
    written: set[str]
    #: 行を入れた・消した派生の表。
    rows: set[str]


#: この接続が表を触った数のうち、まだ書き出していないもの（公式の文書「The Cumulative Statistics System」の
#: `pg_stat_xact_user_tables`。トランザクションの途中から読める）。書き出しは待機に入るときなので、前のトランザクションの分も
#: 残っている——段の前と後を同じトランザクションの中で読んで差を取る。`public`でない側は、段が受ける接続の
#: `current_schema()`（`search_path`の先頭の作業用のスキーマ）。
_TOUCHED_SQL = """
SELECT schemaname, relname, coalesce(seq_scan, 0) + coalesce(idx_scan, 0) AS scans,
       n_tup_ins + n_tup_del AS rows, n_tup_ins + n_tup_upd + n_tup_del AS written
FROM pg_stat_xact_user_tables WHERE schemaname IN ('public', current_schema())
"""


async def _counts(conn: asyncpg.Connection) -> dict[tuple[str, str], dict[str, int]]:
    return {(row["schemaname"], row["relname"]): {kind: row[kind] for kind in ("scans", "rows", "written")}
            for row in await conn.fetch(_TOUCHED_SQL)}


def _ancestors(name: str) -> set[str]:
    stages = {stage.name: stage for stage in derive_cli.STAGES}
    found: set[str] = set()
    pending = list(stages[name].after)
    while pending:
        current = pending.pop()
        if current not in found:
            found.add(current)
            pending.extend(stages[current].after)
    return found


async def test_each_stage_declares_what_it_reads_and_writes(world, monkeypatch):
    """段を選ばずに作り直すと全部の段を流し、世代を進めてその世代の道路網の配列を作る。段ごとに読んだソース・派生の表と
    書いた表を数えて、宣言と比べる。

    - 読んだソースは宣言のソース（住所の段の道路は、パーティションを読まず取込の記録から範囲だけを読むので数に出ない）。
    - 書いた表は宣言の表。
    - 読むだけの表を書く前の段と、書く表の行を入れる・消す前の段は、どれも前の段（たどった先も）にある。
    """
    derived = {table.name for table in derived_tables()}
    touched: dict[str, Touched] = {}
    for stage in derive_cli.STAGES:
        async def derive(conn, *, _real=stage.module.derive, _name=stage.name, **tuning):
            # 数の段が自分のトランザクションに分離レベルを付け、asyncpg は入れ子に外側と同じレベルを求めるので、外側をそれに揃える。
            async with conn.transaction(isolation="repeatable_read"):
                before = await _counts(conn)
                await _real(conn, **tuning)
                after = await _counts(conn)
            grew = {table: {kind: n - before.get(table, {}).get(kind, 0) for kind, n in counts.items()}
                    for table, counts in after.items()}
            work = {name: counts for (schema, name), counts in grew.items()
                    if schema != "public" and name in derived}
            touched[_name] = Touched(
                sources={name.removeprefix("source_features_") for (schema, name), counts in grew.items()
                         if schema == "public" and name.startswith("source_features_") and counts["scans"]},
                read={name for name, counts in work.items() if counts["scans"]},
                written={name for name, counts in work.items() if counts["written"]},
                rows={name for name, counts in work.items() if counts["rows"]})

        monkeypatch.setattr(stage.module, "derive", derive)
    revision = await _revision(world)

    assert await derive_cli.run(postgis_database_url()) == 0

    assert list(touched) == STAGE_NAMES
    assert road_network_store.current().revision == await _revision(world) == revision + 1

    assert {name: touched[name].sources for name in STAGE_NAMES} == {
        stage.name: set(stage.sources) - ({Source.OSM_WAY} if stage.name == "addresses" else set())
        for stage in derive_cli.STAGES}
    assert {name: touched[name].written for name in STAGE_NAMES} == {
        stage.name: set(stage.tables) for stage in derive_cli.STAGES}
    missing: dict[str, set[str]] = {}
    for index, stage in enumerate(derive_cli.STAGES):
        mine = touched[stage.name]
        for prior in derive_cli.STAGES[:index]:
            if prior.name not in _ancestors(stage.name) and (
                    (mine.read - mine.written) & touched[prior.name].written or mine.written & touched[prior.name].rows):
                missing.setdefault(stage.name, set()).add(prior.name)
    assert missing == {}
