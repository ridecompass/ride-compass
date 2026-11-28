"""`infrastructure/road_network_store.py`と`infrastructure/road_network_assembly.py`——取込範囲全体の道路網をDBから組み、
ディスクの置き場へ置き、読む。

入口は`ensure_current`（DBから組んで置く）・`write_pending`と`publish`（派生の作り直しが置く2段）・`save`・
`current`（読む）・`prune_other_shapes`（起動後の片付け）。置き場（`ROOT`）はテストごとの一時ディレクトリ（`backend/tests/conftest.py: road_network_root`）。

DBから組むテストは、道とノードを取込の入口から入れ、派生の作り直し（`batch/derive_cli.py: run`）で区間と材料まで
作ってから組む（本番で作れる行だけを使う。.claude/rules/testing-backend.md パターン8）。置き場を読み書きするテストは、
形だけを持つ小さな`RoadNetwork`を組んで渡す。

ここで見ないもの:
- 区間の切り方・通行方向・信号の導出（派生の段） → `test_derive_topology.py`・`test_resolve_direction.py`・
  `test_derive_nodes.py`
- 材料の値そのもの → `test_material_values.py`
- 置いた道路網から探索範囲を切り出すこと → `test_road_network.py`
- 形の署名の組み立て → `test_cache_identity.py`

材料を区間の束に分けて引くとき、束をまたいで行を続けて詰め、分類の語彙を1つへ付け替えることは、詰める部品
（`infrastructure/road_network_assembly.py: MaterialColumns`）へ束を値で渡して見る——束の大きさ（20万区間）の区間をテストのDBに作らない。
"""

import importlib
import inspect
import logging
import math
import os
import shutil
from dataclasses import fields

import numpy as np
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.batch import derive_cli
from app.domain import elevation_profile, road_network_build
from app.domain.attributes import CategoricalColumn, EdgeMaterialArrays
from app.domain.material_catalog import ELEVATION_GAIN_PER_KM, GRADIENT_PERCENT, MATERIAL_CATALOG
from app.domain.road_network_build import per_km
from app.domain.road_network import RoadNetwork, edge_shape
from app.domain.traffic import highway_rank
from app.infrastructure import road_network_assembly, road_network_store
from app.infrastructure.road_graph_repository import RoadGraphRepository
from tests.conftest import on_test_db, postgis_database_url, raw_connection
from tests.source_ingest import abr_prefecture_record, ingest_records, point_record, way_record, zigzag_point
from tests.road_network_fixture import road_network

@pytest.fixture(autouse=True)
def store(road_network_root):
    """置き場を空の一時ディレクトリにする（`backend/tests/conftest.py: road_network_root`）。"""
    return road_network_root


# --- 置き場の読み書き（DBを使わない） -------------------------------------------------


def _network(revision: int, east_lon: float = 139.001) -> RoadNetwork:
    """ノード2つ・有向の区間2本（同じ区間の両向き）の道路網。材料の名前は架空。"""
    return road_network(
        {1: (35.0, 139.0), 2: (35.001, east_lon)}, {(10, 0): (1, 2)},
        elevation_of={(10, 0): (10.0, 12.0)},
        numeric={"num_a": lambda rows: [1.5, np.nan]},
        categorical={"cat_a": lambda rows: ["x", "y"], "cat_b": lambda rows: [None, "z"]},
        signal_nodes=[2], revision=revision,
    )


def _assert_same(actual: RoadNetwork, expected: RoadNetwork) -> None:
    for f in fields(RoadNetwork):
        got, want = getattr(actual, f.name), getattr(expected, f.name)
        if isinstance(want, np.ndarray):
            assert got.dtype == want.dtype, f.name
            np.testing.assert_array_equal(got, want, err_msg=f.name)
        else:
            assert got == want, f.name


def _other_shape(revision: int) -> str:
    shape = "0" * 12 if road_network_store.NETWORK_SHAPE != "0" * 12 else "1" * 12
    return f"{shape}-r{revision}"


def _place(store, name: str, size: int = 0) -> None:
    (store / name).mkdir(parents=True)
    (store / name / "a.npy").write_bytes(b"\0" * size)


def test_a_published_network_reads_back_as_it_was_built():
    road_network_store.publish(road_network_store.write_pending(_network(revision=4)))

    network = road_network_store.current()

    _assert_same(network, _network(revision=4))
    # 読むのはメモリマップを開くだけ（全リクエストが1つを共有し、常に要る列だけがメモリに載る）。
    assert isinstance(network.distance_m, np.memmap)


def test_a_network_being_written_is_not_read_until_it_is_published(store):
    road_network_store.publish(road_network_store.write_pending(_network(revision=3)))
    pending = road_network_store.write_pending(_network(revision=4))

    assert road_network_store.current().revision == 3
    road_network_store.publish(pending)
    assert road_network_store.current().revision == 4
    assert [path.name for path in store.iterdir()] == [road_network_store.directory_name(4)]


def _disk_full(*args, **kwargs):
    raise OSError(28, "No space left on device")


def test_a_network_that_fails_while_being_placed_leaves_nothing_behind(store, monkeypatch):
    """置く途中で落ちると、呼び手は書きかけのディレクトリを受け取れず消せない。書きかけは名前の形に合わず、
    片付け（`prune`・`prune_other_shapes`）にも拾われないので、残せば道路網1つぶんのディスクを持ち続ける。"""
    road_network_store.publish(road_network_store.write_pending(_network(revision=3)))
    monkeypatch.setattr(os, "fsync", _disk_full)  # 溜めた書き込みが入りきらないと、書き戻しで落ちる

    with pytest.raises(OSError):
        road_network_store.write_pending(_network(revision=4))

    assert [path.name for path in store.iterdir()] == [road_network_store.directory_name(3)]


def test_the_newest_revision_of_the_current_shape_is_read(store):
    """付け替えたあと古い世代を消す前に落ちた置き場が残っていても、最も新しい世代を読む。
    世代が読めなかったDBで作ったもの（None）は、世代のあるものより古い。"""
    store.mkdir()
    for revision in (2, None, 1):
        road_network_store.write_pending(_network(revision)).rename(store / road_network_store.directory_name(revision))
    _place(store, _other_shape(9))
    (store / "not-a-network").mkdir()
    (store / f"{road_network_store.NETWORK_SHAPE}-r99").write_text("ディレクトリではない")

    assert road_network_store.current().revision == 2


def test_a_newer_revision_placed_by_the_batch_is_read_on_the_next_call():
    road_network_store.save(_network(revision=2))
    first = road_network_store.current()
    assert road_network_store.current() is first

    road_network_store.save(_network(revision=3, east_lon=139.002))

    assert road_network_store.current().revision == 3


def test_cleaning_up_after_start_removes_only_networks_of_other_shapes(store):
    road_network_store.save(_network(revision=2))
    _place(store, _other_shape(1), size=10)
    _place(store, _other_shape(2), size=5)
    (store / "not-a-network").mkdir()
    (store / _other_shape(3)).write_text("ディレクトリではない")

    freed = road_network_store.prune_other_shapes()

    assert freed == 15
    assert sorted(path.name for path in store.iterdir()) == sorted(
        [road_network_store.directory_name(2), "not-a-network", _other_shape(3)])


@pytest.mark.parametrize("module", [road_network_assembly, road_network_build, elevation_profile])
def test_the_shape_changes_when_the_code_that_builds_the_network_changes(module):
    """事実から配列を組むコードを直すと、置き場の形の署名が変わる。変わらないと、直したコードのデプロイが、直す前のコードで
    組んだ置き場を読み続ける。"""
    before = road_network_store.NETWORK_SHAPE
    real = inspect.getsource
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(inspect, "getsource", lambda obj: real(obj) + "# 直した" if obj is module else real(obj))
        changed = importlib.reload(road_network_store).NETWORK_SHAPE
    importlib.reload(road_network_store)

    assert changed != before
    assert road_network_store.NETWORK_SHAPE == before


# --- 束ごとの材料を詰める（DBを使わない） ---------------------------------------------


def _batch(distance_m: list[float], surface: list[str | None]) -> EdgeMaterialArrays:
    """区間ごとに距離と分類の材料1列だけが違う束。分類の語彙は束の中で現れた順に番号が付く。"""
    n = len(distance_m)
    nan = np.full(n, np.nan)
    return EdgeMaterialArrays(
        numeric_ids=("num",), numeric_values=np.array(distance_m).reshape(n, 1),
        categorical_ids=("surface",), categorical_columns=(CategoricalColumn.encode(surface),),
        distance_m=np.array(distance_m), bearing_deg=nan, mid_lat=nan, mid_lon=nan,
    )


def test_batches_fill_consecutive_rows_and_share_one_vocabulary():
    """本番の道路網は束（20万区間）より大きく、束ごとに分類の語彙の番号が違う。"""
    columns = road_network_assembly.MaterialColumns(4)
    columns.add(_batch([1.0, 2.0], ["砂利", "舗装"]))
    columns.add(_batch([3.0, 4.0], ["舗装", None]))

    result = columns.result()
    (vocab,) = result["categorical_vocab"]
    assert result["distance_m"].tolist() == [1.0, 2.0, 3.0, 4.0]
    assert result["numeric_values"][:, 0].tolist() == [1.0, 2.0, 3.0, 4.0]
    assert [vocab[code] for code in result["categorical_codes"][:, 0]] == ["砂利", "舗装", "舗装", None]


# --- DBから組む ---------------------------------------------------------------------

#: ノード → (経度, 緯度)。ノード9は道が参照するのに取り込まれていない。
_NODES = {n: zigzag_point(n) for n in (1, 2, 3, 4, 5, 6, 9)}
_INGESTED_NODES = (1, 2, 3, 4, 5, 6)
_SIGNAL_NODE = 3

#: (道, 参照ノード列, タグ)。道500が道100とノード2で交わり、道100は2区間に切れる。
_WAYS = (
    (100, [1, 2, 3], {"highway": "residential"}),
    (200, [3, 4], {"highway": "primary", "oneway": "yes"}),
    (300, [4, 5], {"highway": "residential", "oneway": "-1"}),
    (400, [5, 9], {"highway": "residential"}),
    (500, [2, 6], {"highway": "tertiary"}),
)


async def _derive(ways=_WAYS) -> None:
    """取込の入口から道とノードを入れ、派生の作り直しで区間と材料まで作る。作り直しが置いた道路網は消す。"""
    async with raw_connection() as conn:
        await ingest_records("osm_node", [
            point_record(n, *_NODES[n], {"highway": "traffic_signals"} if n == _SIGNAL_NODE else None) for n in _INGESTED_NODES],
            conn=conn)
        await ingest_records("osm_way", [
            way_record(way_id, [_NODES[n] for n in node_ids], node_ids, tags) for way_id, node_ids, tags in ways],
            conn=conn)
        await ingest_records("abr", [abr_prefecture_record("130001", "東京都", *_NODES[1])], conn=conn)
    assert await derive_cli.run(postgis_database_url()) == 0
    shutil.rmtree(road_network_store.ROOT)


@on_test_db
async def test_the_network_is_built_from_the_derived_tables_with_one_row_per_drivable_direction(
        road_graph_engine, caplog):
    await _derive()
    session_factory = async_sessionmaker(road_graph_engine)

    with caplog.at_level(logging.INFO, logger="ridecompass.road_network"):
        placed = await road_network_store.ensure_current(session_factory)
    network = road_network_store.current()

    async with session_factory() as session:
        repository = RoadGraphRepository(session)
        revision = (await repository.get_data_revisions()).derived
        assert placed.name == road_network_store.directory_name(revision)
        assert network.revision == revision

        # ノードは取り込まれた座標を持つものだけ、番号の昇順。
        assert network.node_osm_id.tolist() == list(_INGESTED_NODES)
        assert network.node_lon.tolist() == pytest.approx([_NODES[n][0] for n in _INGESTED_NODES])
        assert network.node_lat.tolist() == pytest.approx([_NODES[n][1] for n in _INGESTED_NODES])
        assert (network.node_signal_place >= 0).tolist() == [n == _SIGNAL_NODE for n in _INGESTED_NODES]

        # 区間ごとに走れる向きだけ、道・区間の番号順に順方向が先。端点のノードが無い道400の区間は落ちる。
        osm = network.node_osm_id
        directed = [
            (int(w), int(s), bool(f), int(osm[a]), int(osm[b]))
            for w, s, f, a, b in zip(network.edge_way_id, network.edge_segment, network.edge_forward,
                                     network.edge_from, network.edge_to)
        ]
        assert directed == [
            (100, 0, True, 1, 2), (100, 0, False, 2, 1),
            (100, 1, True, 2, 3), (100, 1, False, 3, 2),
            (200, 0, True, 3, 4),
            (300, 0, False, 5, 4),
            (500, 0, True, 2, 6), (500, 0, False, 6, 2),
        ]
        assert "端点のノードが無く落とした有向の区間=2" in caplog.text

        # 区間の階級は道の種別の階級、頂点の階級は集まる区間の一番高い階級（入る区間も出る区間も数える）。
        highways = ["residential"] * 4 + ["primary", "residential", "tertiary", "tertiary"]
        assert network.edge_rank.tolist() == [highway_rank(highway) for highway in highways]
        assert dict(zip(network.node_osm_id.tolist(), network.node_max_rank.tolist())) == {
            1: highway_rank("residential"), 2: highway_rank("tertiary"), 3: highway_rank("primary"),
            4: highway_rank("primary"), 5: highway_rank("residential"), 6: highway_rank("tertiary")}

        # 区間の形は区間の両端を結び、外接矩形は形を囲む。
        for row, (_, _, _, a, b) in enumerate(directed):
            shape = edge_shape(network, row)
            assert (shape[0], shape[-1]) == (pytest.approx([_NODES[a][1], _NODES[a][0]]),
                                             pytest.approx([_NODES[b][1], _NODES[b][0]]))

        for row, (_, _, _, a, b) in enumerate(directed):
            lons, lats = (_NODES[a][0], _NODES[b][0]), (_NODES[a][1], _NODES[b][1])
            assert network.edge_min_lon[row] == pytest.approx(min(lons))
            assert network.edge_max_lon[row] == pytest.approx(max(lons))
            assert network.edge_min_lat[row] == pytest.approx(min(lats))
            assert network.edge_max_lat[row] == pytest.approx(max(lats))

        # 材料は、同じ有向の区間をリポジトリから引いた値と行ごとに揃う。
        materials = await repository.get_edge_material_arrays(
            network.edge_way_id.tolist(), network.edge_segment.tolist(), network.edge_forward.tolist())
    assert network.categorical_ids == materials.categorical_ids
    assert materials.categorical_columns
    for column, (expected, vocab) in enumerate(zip(materials.categorical_columns, network.categorical_vocab)):
        assert vocab[0] is None
        assert [vocab[code] for code in network.categorical_codes[:, column]] == [
            expected.vocab[code] for code in expected.codes]
    # 分類の材料は語彙ごとの番号なので上で読み比べ、ほかの列は値をそのまま比べる（断面から求める材料は配列を作るときに
    # 求めるので、読み出しの値を持たない。`test_road_network.py`）。
    copied = [f.name for f in fields(materials) if f.name not in ("categorical_columns", "numeric_values")]
    assert copied
    for name in copied:
        np.testing.assert_array_equal(getattr(network, name), getattr(materials, name), err_msg=name)
    # 1kmあたりにする材料（`MaterialSpec.per_km`）は、読み出した区間の量を配列が区間の長さで割る。
    read = [i for i, material_id in enumerate(network.numeric_ids) if material_id not in (GRADIENT_PERCENT, ELEVATION_GAIN_PER_KM)]
    read_values = materials.numeric_values[:, read].astype(np.float64)
    for position, column in enumerate(read):
        if MATERIAL_CATALOG[network.numeric_ids[column]].per_km:
            read_values[:, position] = per_km(read_values[:, position], materials.distance_m)
    np.testing.assert_allclose(network.numeric_values[:, read], read_values, rtol=1e-6)


def _bearing(a: int, b: int) -> float:
    """ノード`a`から`b`を見た方位（度、0=北・時計回り）を球面の式で求める。"""
    (lon1, lat1), (lon2, lat2) = (map(math.radians, _NODES[n]) for n in (a, b))
    x = math.sin(lon2 - lon1) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1)
    return math.degrees(math.atan2(x, y)) % 360


@on_test_db
async def test_each_directed_edge_carries_the_bearings_beside_the_node_it_leaves_and_the_node_it_enters(
        road_graph_engine):
    """折れた1区間（ノード2で曲がり、分かれ道は無い）は、出る点のそばと入る点のそばで別の向きを持つ。
    弦（端から端）の向きで交差点の曲がりを測ると、折れ目の向きの変わりが曲がりに混ざる。"""
    await _derive(ways=((100, [1, 2, 3], {"highway": "residential"}),))
    await road_network_store.ensure_current(async_sessionmaker(road_graph_engine))
    network = road_network_store.current()

    osm = network.node_osm_id
    ends = [(int(osm[a]), int(osm[b])) for a, b in zip(network.edge_from, network.edge_to)]
    assert ends == [(1, 3), (3, 1)]
    assert network.edge_start_bearing_deg.tolist() == pytest.approx([_bearing(1, 2), _bearing(3, 2)], abs=0.5)
    assert network.edge_end_bearing_deg.tolist() == pytest.approx([_bearing(2, 3), _bearing(2, 1)], abs=0.5)


@on_test_db
async def test_a_network_already_placed_for_the_current_revision_is_not_built_again(road_graph_engine):
    await _derive()
    session_factory = async_sessionmaker(road_graph_engine)
    placed = await road_network_store.ensure_current(session_factory)
    # 作り直せば置き場ごと置き換わり、この印は残らない。
    (placed / "kept").write_text("", encoding="utf-8")

    assert await road_network_store.ensure_current(session_factory) == placed
    assert (placed / "kept").exists()
