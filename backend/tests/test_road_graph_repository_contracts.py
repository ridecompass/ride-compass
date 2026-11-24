"""`infrastructure/road_graph_repository.py`——DBを要さない契約。

対象は、道路網と材料の読み出しのうち**Python側が決めていること**:

- 地図のフィーチャーの鍵から、区間とwayのどちらの単位で読むか
- 逆向きに辿ったときの列の読み替え規則
- 材料の式が読む列を持つ表だけを結び、宣言に無い列を読む式を断ること
- 行から探索用グラフ・材料の行列を組む部分
- 取込範囲の外（None）と、範囲内で0件（空）の区別
- 路面タイルの材料の列を、どの材料についても値式から組むこと

ここで見ないもの:
- 材料の値式そのもの → `test_material_values.py`、欠損率 → `test_material_coverage.py`
- タイルの形の署名 → `test_cache_identity.py`
- 有向な枝の鍵の書式（`domain/graph.py`の持ち物）と、区間の形と断面の点を向きで読み替えること（`test_road_network.py`）
- スキーマの作成（`create_tables`）と、SQLが実際に返す値

**セッションは差し替えて与える。** 実行した文とパラメータを記録するだけのフェイクを使い、
実在の道路id・タグ・列の値を持ち込まない。材料の列は`material_array_columns()`から導いて
選ぶ（idを名指ししない）。
"""


import numpy as np
import pytest
from sqlalchemy import text

from app.domain.material_catalog import MATERIAL_CATALOG, material_array_columns
from app.domain.region import BoundingBox
from app.infrastructure.derived_models import EdgeCountsRow, EdgeElevationRow, EdgeLandcoverRow
from app.infrastructure.material_joins import reversed_partner
from app.infrastructure.road_graph_repository import (
    ID_CHUNK_SIZE,
    MATERIAL_ARRAY_COLUMN_ORDER,
    RoadGraphRepository,
)

BBOX = BoundingBox(min_latitude=35.0, min_longitude=139.0,
                   max_latitude=35.1, max_longitude=139.1)


class _Row:
    """DBの1行。属性・位置・`_mapping`のどれでも読める（読み出し側が3通り使う）。"""

    def __init__(self, **values):
        self._mapping = dict(values)
        self.__dict__.update(values)

    def __iter__(self):
        return iter(self._mapping.values())


class _Result:
    def __init__(self, rows):
        self._rows = list(rows)

    def all(self):
        return list(self._rows)

    def first(self):
        return self._rows[0] if self._rows else None

    def one(self):
        (row,) = self._rows
        return row

    def scalar(self):
        return next(iter(self._rows[0])) if self._rows else None

    def __iter__(self):
        return iter(self._rows)


class _FakeSession:
    """`execute`だけを持つセッション。呼ばれた順に用意した行を返し、文とパラメータを残す。"""

    def __init__(self, *results):
        self._results = list(results)
        self.calls: list[tuple[object, dict | None]] = []

    async def execute(self, statement, params=None):
        self.calls.append((statement, params))
        return _Result(self._results.pop(0))

    @property
    def params(self) -> list[dict | None]:
        return [params for _, params in self.calls]


def _repo(*results) -> tuple[RoadGraphRepository, _FakeSession]:
    session = _FakeSession(*results)
    return RoadGraphRepository(session), session


# --- 逆向きの読み替え ---------------------------------------------------------


@pytest.mark.parametrize(("name", "partner"), [
    ("start_a", ("end_a", False)),
    # 勾配は符号を返す
    ("a_grade", ("a_grade", True)),
    # 向きで変わらない列
    ("a_count", None),
])
def test_reversed_partner_swaps_paired_tokens_and_flips_grades(name, partner):
    assert reversed_partner(name) == partner


def test_reversing_twice_returns_to_the_original_column():
    """対が壊れると、逆向きの枝の標高が別の列から来る。列の一覧は宣言から導く。"""
    reversed_columns = {column.name: partner
                        for row in (EdgeCountsRow, EdgeElevationRow, EdgeLandcoverRow) for column in row.__table__.columns
                        if (partner := reversed_partner(column.name)) is not None}
    assert reversed_columns, "向きで変わる列が1つも無い"
    for name, (partner, negated) in reversed_columns.items():
        assert reversed_partner(partner) == (name, negated)


# --- 材料の行列 ---------------------------------------------------------------


def _arrays_row(count: int, values: dict[str, list] | None = None) -> _Row:
    """材料配列のクエリが返す1行。列は`c_<名前>`で、渡さない列は欠損で埋める。"""
    given = values or {}
    return _Row(**{f"c_{name}": list(given.get(name, [None] * count))
                   for name in MATERIAL_ARRAY_COLUMN_ORDER})


async def test_material_values_land_in_the_matrix_of_their_dtype():
    """分類を数値の行列へ混ぜられないため、数値と分類の2つに分かれる。真偽は数値の行列に1.0/0.0で載る。"""
    numeric_ids, categorical_ids = material_array_columns()
    boolean = next(m for m in numeric_ids if MATERIAL_CATALOG[m].dtype == "boolean")
    numeric = next(m for m in numeric_ids if MATERIAL_CATALOG[m].dtype == "numeric")
    assert categorical_ids, "分類の材料が無い"
    categorical = categorical_ids[0]
    repo, _ = _repo([_arrays_row(3, {numeric: [1.5, None, None], boolean: [True, False, None],
                                     categorical: ["value_a", None, None]})])

    arrays = await repo.get_edge_material_arrays([1, 1, 1], [0, 1, 2], [True, True, True])

    numbers = arrays.numeric_values[:, [arrays.numeric_ids.index(numeric), arrays.numeric_ids.index(boolean)]].T
    assert numbers[0][0] == 1.5
    # 欠損は0ではなくNaN。0で埋めると「値が無い」が「一番良い値」として採点される。
    assert np.isnan(numbers[0][1])
    # 真偽の欠損（道の生データが無い区間）も、非該当（0.0）ではなく不明（NaN）。
    assert numbers[1][:2].tolist() == [1.0, 0.0]
    assert np.isnan(numbers[1][2])
    # 分類の材料は語彙への番号の列で、値へ戻すと行ごとの値（値なしはNone）になる。
    column = arrays.categorical_columns[arrays.categorical_ids.index(categorical)]
    assert [column.value_at(row) for row in range(len(column))] == ["value_a", None, None]


class _EchoingArraysSession:
    """材料配列のクエリに、受け取った区間をそのまま値として返すセッション（DBの`WITH ORDINALITY`の代わり）。
    way・区間の番号・向きを、それぞれ距離・方位・中点の緯度（順向きは1、逆向きは0）の列に入れる。"""

    async def execute(self, statement, params):
        count = len(params["way_ids"])
        return _Result([_arrays_row(count, {"distance_m": params["way_ids"],
                                            "bearing_deg": params["segment_indexes"],
                                            "mid_lat": [float(f) for f in params["forwards"]]})])


async def test_rows_keep_the_order_of_the_given_edges_across_chunks():
    """並びは渡した区間の位置で決まる。1文に載る数を超えて分けても、1つでもずれると値が列の間で静かに入れ替わる。"""
    count = ID_CHUNK_SIZE + 1
    way_ids = list(range(count))
    segment_indexes = [i % 7 for i in way_ids]
    forwards = [i % 2 == 0 for i in way_ids]

    arrays = await RoadGraphRepository(_EchoingArraysSession()).get_edge_material_arrays(
        way_ids, segment_indexes, forwards)

    assert arrays.distance_m.tolist() == way_ids
    assert arrays.bearing_deg.tolist() == segment_indexes
    assert arrays.mid_lat.tolist() == [float(f) for f in forwards]


async def test_an_edge_without_an_elevation_row_has_no_profile_points():
    """断面の点は、区間ごとの点の数と、渡した区間の順に隙間なく並べた標高と位置（区間の長さに対する割合）で返す。標高の行が
    無い区間は点を持たず（点が2つ未満の区間は、所要時間が全体の勾配の分布で埋める）、位置を持たない行（作り直す前の行）は点を
    等しい間隔に置く。"""
    repo, _ = _repo([_Row(elevation_profile_m=[1.0, np.nan, 3.0], elevation_profile_along_m=[0.0, 4.0, 10.0]),
                     _Row(elevation_profile_m=[2.0, 5.0], elevation_profile_along_m=None),
                     _Row(elevation_profile_m=None, elevation_profile_along_m=None)])

    points, elevation, position = await repo.get_edge_elevation_profiles([1, 2, 3], [0, 0, 0])

    assert list(points) == [3, 2, 0]
    assert np.array_equal(elevation, [1.0, np.nan, 3.0, 2.0, 5.0], equal_nan=True)
    assert np.allclose(position, [0.0, 0.4, 1.0, 0.0, 1.0])


# --- way粒度の読み出し --------------------------------------------------------


async def test_way_is_looked_up_by_its_key_as_text():
    """道の生データの主キー（`source_features.natural_key`）はtext。数で渡すと1件も当たらず、
    道の窓が常に空になる。"""
    repo, session = _repo([_Row(highway="highway_a", tags={"tag_a": "value_a"})], [])

    await repo.get_way_tags_by_osm_way_id(123)

    assert session.params[0]["osm_way_id"] == "123"


async def test_unknown_way_has_no_tags():
    repo, _ = _repo([], [])

    assert await repo.get_way_tags_by_osm_way_id(123) is None


# --- 事故の収録年 -------------------------------------------------------------


@pytest.mark.parametrize(("read", "years"), [([2023, 2021, 2022], [2021, 2022, 2023]), (None, [])])
async def test_accident_years_are_the_years_the_run_read(read, years):
    """実データの発生年を数えない——事故が1件も無かった年が落ちて、地図の説明の年が欠ける。"""
    repo, _ = _repo([_Row(years=read)])

    assert await repo.get_accident_years() == years


# --- タイル -------------------------------------------------------------------

# タイル1枚を焼く口。路面の口はこの口へSQLを渡すだけ。SQLはフェイクのセッションが実行しない。
def _read_mvt(repo):
    return repo.get_tile_mvt(text("SELECT 1"), "layer", 14, 1, 2, BBOX)


@pytest.mark.parametrize(("tile", "payload"), [
    # 長さ0のバイト列は「featureが1つも無い有効なMVT」として地図がそのまま受理する
    (None, b""),
    (memoryview(b"tile_a"), b"tile_a"),
])
async def test_tile_inside_the_imported_area_is_bytes_even_without_features(tile, payload):
    repo, _ = _repo([_Row(covered=True, tile=tile)])

    assert await _read_mvt(repo) == payload
