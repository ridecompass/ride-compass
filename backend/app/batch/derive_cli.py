"""派生を作り直す入口。**順番と、段ごとの入力の宣言はここだけが持つ**。

生データを差し替えたら、下流を作り直す。段は次の依存で決まっており、並べ替えられない:
形（`road_edges`）が無いと値の行が作れず、ノードの枝数と種別が無いと交差点と停止要因を数えられない。
派生の表はどれも書く段が1つで（`infrastructure/derived_models.py`）、段は自分の表を空にしてから埋める。

    .venv\\Scripts\\python.exe -m app.batch.derive_cli                      # 全部の段
    .venv\\Scripts\\python.exe -m app.batch.derive_cli --stages elevation   # 標高の段（と、それを読む後ろの段）
    .venv\\Scripts\\python.exe -m app.batch.derive_cli --stages network     # 段を流さず、道路網の配列だけ

**作り直す段は人が選ぶ。** 何が変わったかを自動で判定して段を飛ばす仕組みは持たない。選んだ段の出力を読む後ろの段
（`after`。たどった先も）は入口が足す——区間を切る段は値の表を空にするので、topology を選べば区間を指す段も全部流れる。
引数が無ければ全部の段を流す。流した段は、どの区間もすべて計算する。

**道路網の配列は毎回作る**（本番で数分）。配列が読む表を書く段を流したかで分けない。配列は、段の後ろに必ず流れる
最後の段（`NETWORK`）として扱い、`--stages network`は段を流さずに配列だけを作る（配列だけが読む較正値を変えたとき）。

段が何を読むかは`STAGES`の宣言が持ち、宣言の漏れは段が読んだ表の数で見張る（`tests/test_derive_stages.py: test_each_stage_declares_what_it_reads_and_writes`）。
前の段（`after`）には、読む表を書く段と、自分が書く表の行を入れる・消す段を挙げる（区間を切る段は、区間・道・頂点を
外部キーで指す値の表を空にする）。
作り直しは取込・DBのバックアップと同時に走らない（`common.py: SOURCE_DATA_LOCK`）。

**作り直しは作業用のスキーマで行い、道路網の配列まで作ってから1つのトランザクションで`public`の
表と入れ替える**（仕組みと理由は`docs/modules/backend/static-road-attributes.md`「派生」）。
段のSQLは表の名前をスキーマを付けずに書く——接続の`search_path`が作業用のスキーマを先に探し、
流さない段の表と生データは`public`から読む。

**段が読む較正値は、作り直しを始めるときに1度だけDBの表から読み、段の関数へ値で渡す**。
バッチはwebアプリと別のプロセスで、プロセス内の較正値（`domain/tuning.py: TUNING_VALUES`）へは
何も読み込まれていない。
段へ渡るのは`STAGES`が宣言した較正値だけである。

**作り直しの記録（作った取込・表の列・使った較正値。`derived_data_meta.py`）は、鍵（取込のソース・表・較正値）ごとに、
それを使う段が全部流れたときだけ今の値にし、ほかは前回の記録を残す**（`carried_over`）——流さなかった段の表は前回の取込・列・
較正値で作ったままなので、今の値を書くと鮮度の台帳と、記録を読む所（事故密度の分母・地図の点のタイル等）が表と食い違う。
道路網の配列が読む較正値は、配列（`NETWORK`）が毎回流れるので毎回今の値になる。
"""

import argparse
import logging
import shutil
import time
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import TypeVar

import asyncpg

from app.batch import (
    derive_addresses,
    derive_counts,
    derive_elevation,
    derive_landcover,
    derive_nodes,
    derive_places,
    derive_topology,
    derive_traffic_regulations,
    derive_way_directions,
)
from app.batch.common import (
    SOURCE_DATA_LOCK,
    asyncpg_dsn,
    batch_session_factory,
    format_duration,
    run_batch_cli,
)
from app.infrastructure.tuning_overrides import load_tuning_values
from app.infrastructure import derived_data_meta, road_network_store
from app.infrastructure.derived_data_freshness import declared_columns
from app.domain.tuning import (
    ACCIDENT_FATAL_WEIGHT_ID,
    ACCIDENT_MATCH_DISTANCE_ID,
    ELEVATION_BRIDGE_END_RADIUS_ID,
    ELEVATION_PROFILE_STEP_ID,
    LANDCOVER_RING_INNER_ID,
    LANDCOVER_RING_OUTER_ID,
    REGULATION_EDGE_SHARE_ID,
    REGULATION_LINE_HALF_WIDTH_ID,
    REGULATION_MAX_ANGLE_ID,
    SIGNAL_MATCH_RADIUS_ID,
    STOP_CLUSTER_DISTANCE_ID,
)
from app.infrastructure.road_graph_repository import NETWORK_TUNING, RoadGraphRepository
from app.infrastructure.source_models import LATEST_SUCCEEDED_RUNS_SQL, Source

logger = logging.getLogger("ridecompass.derive_cli")


@dataclass(frozen=True)
class DeriveStage:
    """段1つの宣言。"""

    name: str
    #: 段のモジュール。`derive(conn, **較正値)`を持つ。
    module: ModuleType
    #: 読むソース。流したとき、作り直しの記録のこのソースの取込を今の取込にする。
    sources: frozenset[Source]
    #: 前の段（名前。この段より前にあるもの）。挙げる基準は冒頭。
    after: tuple[str, ...]
    #: 書く派生の表。
    tables: tuple[str, ...]
    #: `derive`の引数の名前 → 渡す較正値のid。
    tuning: Mapping[str, str] = field(default_factory=dict)

    async def run(self, conn: asyncpg.Connection, tuning: Mapping[str, float]) -> None:
        await self.module.derive(conn, **{argument: tuning[param] for argument, param in self.tuning.items()})
        # 後ろの段と配信はこれらの表を読む。autovacuumは既定60秒周期の背景処理で、派生は数秒で走り切るため、
        # 統計が付くのを待てない。無いまま読まれると実行計画が桁で外れる。
        await conn.execute(f"ANALYZE {', '.join(self.tables)}")


STAGES: tuple[DeriveStage, ...] = (
    DeriveStage("topology", derive_topology, frozenset({Source.OSM_WAY}), (), ("road_edges", "road_ways", "road_nodes")),
    DeriveStage("nodes", derive_nodes, frozenset({Source.OSM_NODE, Source.OSM_WAY}), ("topology",),
                ("node_kinds", "node_turns"), {"signal_radius_m": SIGNAL_MATCH_RADIUS_ID}),
    DeriveStage("counts", derive_counts, frozenset({Source.OSM_NODE, Source.OSM_WAY, Source.ACCIDENT}),
                ("topology", "nodes"), ("edge_counts", "way_counts"),
                {"cluster_distance_m": STOP_CLUSTER_DISTANCE_ID, "accident_fatal_weight": ACCIDENT_FATAL_WEIGHT_ID,
                 "accident_match_distance_m": ACCIDENT_MATCH_DISTANCE_ID}),
    # 標高の段は、道から区間が橋かトンネルかだけを読み、その値を区間ごとに表へ残す。
    DeriveStage("elevation", derive_elevation, frozenset({Source.OSM_WAY, Source.DEM}), ("topology",), ("edge_elevation",),
                {"profile_step_m": ELEVATION_PROFILE_STEP_ID, "bridge_end_radius_m": ELEVATION_BRIDGE_END_RADIUS_ID}),
    DeriveStage("landcover", derive_landcover, frozenset({Source.LULC}), ("topology",), ("edge_landcover", "way_landcover"),
                {"ring_outer_m": LANDCOVER_RING_OUTER_ID, "ring_inner_m": LANDCOVER_RING_INNER_ID}),
    DeriveStage("traffic_regulations", derive_traffic_regulations, frozenset({Source.JARTIC_REGULATION}), ("topology",),
                ("edge_traffic_regulations",),
                {"line_half_width_m": REGULATION_LINE_HALF_WIDTH_ID, "edge_share": REGULATION_EDGE_SHARE_ID,
                 "max_angle_deg": REGULATION_MAX_ANGLE_ID}),
    DeriveStage("directions", derive_way_directions, frozenset({Source.OSM_WAY}), ("topology",), ("way_directions",)),
    # 住所の区画は、道路（`osm_way`）のパーティションを読まず、取込の記録から範囲だけを読む（読んだ数の見張りに出ないので、
    # 手で挙げる）。
    DeriveStage("addresses", derive_addresses, frozenset({Source.ABR, Source.ISJ_BLOCK, Source.OSM_WAY}), (),
                ("address_areas", "address_search_keys", "address_blocks")),
    DeriveStage("places", derive_places,
                frozenset({Source.OVERTURE_PLACE, Source.BUNKA_HERITAGE, Source.ESTAT_SMALL_AREA}), (),
                ("places",)),
)


STAGE_NAMES: tuple[str, ...] = tuple(stage.name for stage in STAGES)
#: 段の後ろに必ず流れる道路網の配列の名前。段の名前と並べて`--stages`で選べ、選ぶと段を流さずに配列だけを作る。
NETWORK = "network"


def _check_order(stages: Sequence[DeriveStage]) -> None:
    """前の段（`after`）がどれも前にあること。`stages_to_run`は段の順に1度なめて後ろの段を足すので、これが崩れると黙って落とす。"""
    seen: set[str] = set()
    for stage in stages:
        if missing := set(stage.after) - seen:
            raise RuntimeError(f"段 {stage.name} の前の段が前に無い: {sorted(missing)}")
        seen.add(stage.name)


_check_order(STAGES)


def stages_to_run(names: Sequence[str] | None) -> list[DeriveStage]:
    """選んだ段（Noneか空なら全部の段）と、その出力を読む後ろの段（`after`をたどった先も）を、段の順に並べる。
    `NETWORK`だけを選べば段は流さない（配列はどのときも作る）。"""
    if not names:
        return list(STAGES)
    unknown = sorted(set(names) - {*STAGE_NAMES, NETWORK})
    if unknown:
        raise ValueError(f"知らない段: {unknown}（段は {', '.join((*STAGE_NAMES, NETWORK))}）")
    chosen = set(names) - {NETWORK}
    for stage in STAGES:
        if chosen & set(stage.after):
            chosen.add(stage.name)
    return [stage for stage in STAGES if stage.name in chosen]


def _users(pairs: Iterable[tuple[str, str]]) -> dict[str, frozenset[str]]:
    users: dict[str, set[str]] = {}
    for key, user in pairs:
        users.setdefault(key, set()).add(user)
    return {key: frozenset(names) for key, names in users.items()}


#: 作り直しの記録の鍵ごとの、その鍵を使う段（道路網の配列は`NETWORK`）。取込のソースは読む段、表は書く段、較正値は読む段。
SOURCE_USERS = _users((source, stage.name) for stage in STAGES for source in stage.sources)
TABLE_USERS = _users((table, stage.name) for stage in STAGES for table in stage.tables)
TUNING_USERS = _users([*((param, stage.name) for stage in STAGES for param in stage.tuning.values()),
                       *((param, NETWORK) for param in NETWORK_TUNING)])

_V = TypeVar("_V")


def carried_over(previous: Mapping[str, _V], current: Mapping[str, _V], users: Mapping[str, frozenset[str]],
                 ran: Iterable[str]) -> dict[str, _V]:
    """作り直しの記録に書く値（鍵は`users`の鍵）: 使う段が全部流れた鍵は今の値、ほかは前回の記録。前回に無ければ書かない——
    読み手は記録の無い較正値を読めず（読む段を流し直す）、鮮度の台帳は記録の無い鍵を作り直しが要る側に数える。"""
    done = {*ran, NETWORK}
    result: dict[str, _V] = {}
    for key, used_by in users.items():
        if key in current and used_by <= done:
            result[key] = current[key]
        elif key in previous:
            result[key] = previous[key]
    return result


#: 作り直す間の表を置くスキーマ。同時に2本走ると互いの表を消し合うため、作り直しは排他の鍵
#: （`SOURCE_DATA_LOCK`）を取って1本に限る。
_WORK_SCHEMA = "derived_rebuild"

#: 作業用のスキーマに作る表の、索引を伴う制約（主キー・一意）と外部キー。外部キーは参照先の鍵の後に作る。
#: 定義は`search_path`が`public`だけのときに読むので、`public`の表は名前だけで出る——
#: 作業用のスキーマを先に探す接続で打てば、作業用のスキーマに作った表どうしを指し、作らなかった派生の表と生データの表は
#: `public`を指す。
_CONSTRAINTS_SQL = """
SELECT r.relname AS table_name, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE n.nspname = 'public' AND r.relname = ANY($1::text[]) AND c.contype IN ('p', 'u', 'x', 'f')
ORDER BY c.contype = 'f', r.relname, c.conname
"""

#: 制約に属さない索引（空間索引等）。名前を保つため、定義を写して作る。
_INDEXES_SQL = """
SELECT r.relname AS table_name, pg_get_indexdef(x.indexrelid) AS definition
FROM pg_index x
JOIN pg_class r ON r.oid = x.indrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE n.nspname = 'public' AND r.relname = ANY($1::text[])
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conindid = x.indexrelid AND c.conrelid = x.indrelid)
ORDER BY r.relname
"""


async def _create_work_tables(conn: asyncpg.Connection, tables: list[str]) -> None:
    """`tables`を空で作業用のスキーマに作り、接続がそちらを先に探すようにする。

    列・既定値・検査制約は`LIKE`で、鍵・外部キー・索引は`public`の定義から名前ごと写す——
    入れ替えた後の`public`の表は、入れ替える前と同じ名前の制約と索引を持つ。行は段が入れる。
    """
    await conn.execute("SET search_path = public")
    constraints = await conn.fetch(_CONSTRAINTS_SQL, tables)
    indexes = await conn.fetch(_INDEXES_SQL, tables)
    await conn.execute(f"DROP SCHEMA IF EXISTS {_WORK_SCHEMA} CASCADE")
    await conn.execute(f"CREATE SCHEMA {_WORK_SCHEMA}")
    for table in tables:
        await conn.execute(
            f"CREATE TABLE {_WORK_SCHEMA}.{table} (LIKE public.{table} INCLUDING ALL EXCLUDING INDEXES)")
    await conn.execute(f"SET search_path = {_WORK_SCHEMA}, public")
    for row in constraints:
        await conn.execute(f'ALTER TABLE {row["table_name"]} ADD CONSTRAINT {row["name"]} {row["definition"]}')
    for row in indexes:
        qualified = f" ON public.{row['table_name']} "
        if qualified not in row["definition"]:
            raise RuntimeError(f"索引の定義を読み替えられない: {row['definition']}")
        await conn.execute(row["definition"].replace(qualified, f" ON {_WORK_SCHEMA}.{row['table_name']} ", 1))
    logger.info("作業用のスキーマ %s に表を作った: %s", _WORK_SCHEMA, ", ".join(tables))


async def _build_road_network(database_url: str, revision: int) -> Path:
    """作業用のスキーマ（流さなかった段の表は`public`）の表から道路網の配列を作り、読み手がまだ拾わない名前で置く。"""
    started = time.perf_counter()
    async with batch_session_factory(database_url, schema=_WORK_SCHEMA) as session_factory:
        async with session_factory() as session:
            network = await road_network_store.build(RoadGraphRepository(session), revision)
    pending = road_network_store.write_pending(network)
    logger.info("道路網の配列を作った / %s", format_duration(time.perf_counter() - started))
    return pending


async def _swap(conn: asyncpg.Connection, tables: list[str]) -> None:
    """`public`の派生の表を作業用のスキーマの表で置き換え、世代を進める（1トランザクション）。"""
    started = time.perf_counter()
    async with conn.transaction():
        await conn.execute("DROP TABLE " + ", ".join(f"public.{table}" for table in tables))
        for table in tables:
            await conn.execute(f"ALTER TABLE {_WORK_SCHEMA}.{table} SET SCHEMA public")
        await derived_data_meta.bump_revision(conn)
    logger.info("派生の表を入れ替えた / 表の排他ロック（待ちを含む）=%.1fs", time.perf_counter() - started)


async def _read_tuning(database_url: str) -> dict[str, float]:
    """いま効くべき較正値（webアプリが起動時に読むのと同じ値）。"""
    async with batch_session_factory(database_url) as session_factory:
        async with session_factory() as session:
            return await load_tuning_values(session)


async def run(database_url: str, stages: Sequence[str] | None = None) -> int:
    """`stages`の段（Noneか空なら全部の段）と、その出力を読む後ろの段を作り直し、道路網の配列を作って入れ替える。"""
    ran = stages_to_run(stages)
    columns = declared_columns()
    tuning = await _read_tuning(database_url)
    conn = await asyncpg.connect(asyncpg_dsn(database_url))
    if not await conn.fetchval("SELECT pg_try_advisory_lock(hashtext($1))", SOURCE_DATA_LOCK):
        await conn.close()
        raise RuntimeError("別の派生の作り直しか取込かDBのバックアップが走っている")
    pending: Path | None = None
    started = time.perf_counter()
    try:
        runs = {row["source"]: row["run_id"] for row in await conn.fetch(LATEST_SUCCEEDED_RUNS_SQL)}
        previous = await derived_data_meta.read_records(conn)
        # 作った取込・列・較正値の記録も作業用のスキーマで書く——事故密度の分母が取込の記録から読まれ、作業用の
        # スキーマから作る道路網の配列も数と同じ取込の年で割り、記録した較正値で読むため。どの記録も派生の表と一緒に入れ替わる。
        tables = [*(table for stage in ran for table in stage.tables), *derived_data_meta.RECORD_TABLES]
        await _create_work_tables(conn, tables)
        done = [stage.name for stage in ran]
        await derived_data_meta.replace_source_runs(conn, carried_over(previous.runs, runs, SOURCE_USERS, done))
        await derived_data_meta.replace_columns(conn, carried_over(previous.columns, columns, TABLE_USERS, done))
        await derived_data_meta.replace_tuning(conn, carried_over(previous.tuning, tuning, TUNING_USERS, done))
        for index, stage in enumerate(ran, 1):
            stage_started = time.perf_counter()
            logger.info("段 %s を開始（%d/%d）", stage.name, index, len(ran))
            await stage.run(conn, tuning)
            logger.info("段 %s 完了 / %s", stage.name, format_duration(time.perf_counter() - stage_started))
        revision = await conn.fetchval("SELECT revision FROM derived_data_meta") + 1
        pending = await _build_road_network(database_url, revision)
        await _swap(conn, tables)
        road_network_store.publish(pending)
        pending = None
    finally:
        if pending is not None:
            shutil.rmtree(pending, ignore_errors=True)
        try:
            await conn.execute(f"DROP SCHEMA IF EXISTS {_WORK_SCHEMA} CASCADE")
        except (asyncpg.PostgresError, OSError):
            logger.warning("作業用のスキーマ %s を消せなかった（次の作り直しの最初に消す）",
                           _WORK_SCHEMA, exc_info=True)
        await conn.close()
    logger.info("派生を作り直して入れ替えた: 流した段 %s / 派生データの世代 %d / %s",
                "→".join([*(stage.name for stage in ran), NETWORK]), revision, format_duration(time.perf_counter() - started))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="生データから派生を作り直す（選んだ段と、それを読む後ろの段。選ばなければ全部の段）")
    parser.add_argument("--stages", nargs="+", metavar="段",
                        help=f"作り直す段（{', '.join(STAGE_NAMES)}）。その出力を読む後ろの段も流す。"
                             f"{NETWORK}は段を流さず道路網の配列だけを作る")
    return run_batch_cli(parser, lambda args, database_url: run(database_url, args.stages))


if __name__ == "__main__":
    raise SystemExit(main())
