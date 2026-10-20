"""材料の値を求めるSQLの式が、入力に対して返す値。

式の部品は`domain/material_sql.py`、材料ごとの式はカタログ（`domain/material_catalog.py: material_value_sql`）が持つ。
SQLの中の条件はPythonのカバレッジに現れないので、式をテスト用DBで評価して値を見る。

入力の作り方:
- 道（別名`w`）: 道を取込の入口（`tests/source_ingest.py`）から入れ、読み手と同じ副問い合わせ
  （`infrastructure/source_models.py: WAYS_SOURCE_SQL`）で読む。
- 区間（`re`）・区間の値（`em`）: 派生の段が書く表の行の型（`road_edges`と、区間の値の表を並べたもの）で値を与える。
  値そのものの出し方（件数を数える等）は派生の段の責務なので、ここでは作らない。

部品の節は架空のタグで、タイルへの載せ方の節は架空の材料で確かめる。カタログの節は、カタログに直に書かれた式（部品を使わないもの）を
本物の材料のidで引く——そこでは、その材料が何を返すかがテストの関心である。

カタログの全部の式が、読み出しの各経路（`infrastructure/road_graph_repository.py: RoadGraphRepository`の区間の材料・
道1本・道の標本・路面タイル・タイルのフィーチャーごとの材料・土地被覆の内訳）の中で実在の列だけを読むことも見る。上の節は別名を値で与えるので、
綴りの合わない列や、経路に無い別名を読む式を見つけられない。道の標本の経路は、範囲を絞ると抽選しないことも見る
（セッションを差し替える契約のテストには、SQLが返す値が現れない）。

ここで見ないもの:
- 読み出しの経路が結果をどの形に並べるか（列と材料の対応・取込範囲の外のタイル） → `test_road_graph_repository_contracts.py`
- 欠損率の集計 → `test_material_coverage.py`
- 部品をどの材料がどのタグで使うか（カタログの宣言） → 宣言そのもので、テストに書き写さない
"""

import json

import pytest
from sqlalchemy import text

from app.domain import material_sql
from app.domain.material_catalog import (
    ACCIDENT_COUNT_PER_KM_YEAR,
    CoverageExcluded,
    MaterialSpec,
    material_value_sql,
    tile_column_sql,
)
from app.domain.region import BoundingBox
from app.infrastructure.source_models import WAYS_SOURCE_SQL
from tests.source_ingest import ingest_records, way_record

pytestmark = pytest.mark.asyncio(loop_scope="module")


async def _ingest_ways(tags_by_way: dict[int, dict[str, str]]) -> None:
    """道ごとのタグで道を取り込む。"""
    await ingest_records("osm_way", [
        way_record(way_id, [(139.70, 35.68 + 0.001 * way_id), (139.701, 35.68 + 0.001 * way_id)],
                   [way_id * 10, way_id * 10 + 1], tags)
        for way_id, tags in tags_by_way.items()])


async def _way_values(session, expression: str, tags_by_way: dict[int, dict[str, str]]) -> dict[int, object]:
    """道ごとのタグで道を取り込み、式を道ごとに評価する。"""
    await _ingest_ways(tags_by_way)
    rows = await session.execute(text(f"SELECT w.osm_way_id, ({expression}) FROM {WAYS_SOURCE_SQL} w"))
    return dict(rows.all())


async def _edge_value(session, expression: str, *, distance_m: float, accident_years: int = 1,
                      **edge_values: float | None) -> object:
    """区間の長さと区間の値を与えて、式を1区間ぶん評価する。"""
    row = await session.execute(
        text(f"SELECT ({expression})"
             " FROM json_populate_record(NULL::road_edges, CAST(:re AS json)) re,"
             " (SELECT * FROM json_populate_record(NULL::edge_counts, CAST(:em AS json)) c,"
             "  json_populate_record(NULL::edge_elevation, CAST(:em AS json)) e,"
             "  json_populate_record(NULL::edge_landcover, CAST(:em AS json)) l) em"),
        {"re": json.dumps({"distance_m": distance_m}), "em": json.dumps(edge_values),
         "accident_years": accident_years})
    return row.scalar_one()


# --- 部品（domain/material_sql.py） ---------------------------------------------------


@pytest.mark.parametrize(("tag", "expected"), [
    (" 60 ", 60),
    ("40.7", 40),  # 小数は切り捨てる
    ("0.5", None),  # 切り捨てると0
    ("50 mph", None),
])
async def test_a_number_tag_has_a_value_only_when_it_is_a_positive_number(road_graph_session, tag, expected):
    values = await _way_values(road_graph_session, material_sql.positive_integer_tag_sql("tag_a"),
                               {1: {"tag_a": tag}})

    assert values == {1: expected}


async def test_a_tag_with_the_value_is_true_and_an_absent_tag_is_false(road_graph_session):
    values = await _way_values(road_graph_session, material_sql.tag_is_value_sql("tag_a", "yes"),
                               {1: {"tag_a": " Yes "}, 2: {"tag_a": "no"}, 3: {}})

    assert values == {1: True, 2: False, 3: False}


async def test_a_tag_condition_is_unknown_where_the_road_has_no_raw_way(road_graph_session):
    """取込で消えた道を、派生を作り直すまで区間が指し続ける（区間の材料の読み手は`w`を外部結合する）。
    道が無いことは、タグが無いこと（非該当）ではない。"""
    row = await road_graph_session.execute(text(
        f"SELECT ({material_sql.tag_is_value_sql('tag_a', 'yes')})"
        f" FROM (VALUES (1)) AS edge(id) LEFT JOIN {WAYS_SOURCE_SQL} w ON false"))

    assert row.scalar_one() is None


async def test_a_cycleway_value_on_any_side_counts(road_graph_session):
    values = await _way_values(road_graph_session, material_sql.cycleway_has_value_sql("value_a", "value_b"), {
        1: {"cycleway:both": " Value_B "},
        # 値の無い道も同じ側（NULLだけの配列との`&&`もfalse）。
        2: {"cycleway": "no", "cycleway:left": "other"},
    })

    assert values == {1: True, 2: False}


# --- カタログに直に書かれた式（domain/material_catalog.py） -----------------------------


@pytest.mark.parametrize(("count", "distance_m", "years", "expected"), [
    (3.0, 500.0, 2, 3.0),
    (3.0, 500.0, 0, None),  # 収録年の無い取込
])
async def test_the_accident_density_is_per_km_and_per_year_covered(road_graph_session, count, distance_m, years,
                                                                    expected):
    value = await _edge_value(road_graph_session, material_value_sql()[ACCIDENT_COUNT_PER_KM_YEAR],
                              distance_m=distance_m, accident_years=years, accident_count=count)

    assert value == (None if expected is None else pytest.approx(expected))


async def test_a_road_is_a_cycleway_by_its_own_kind(road_graph_session):
    values = await _way_values(road_graph_session, material_value_sql()["highway_is_cycleway"],
                               {1: {"highway": "cycleway"}, 2: {"highway": "residential", "cycleway": "track"}})

    assert values == {1: True, 2: False}


async def test_a_shared_pedestrian_path_is_a_footway_or_path_that_lets_bicycles_in(road_graph_session):
    values = await _way_values(road_graph_session, material_value_sql()["shared_pedestrian_path"], {
        1: {"highway": "path", "bicycle": " Designated "},
        2: {"highway": "footway", "bicycle": "no"},
        3: {"highway": "path"},
        4: {"highway": "residential", "bicycle": "yes"},
    })

    assert values == {1: True, 2: False, 3: False, 4: False}


# --- タイルへの載せ方（domain/material_catalog.py: tile_column_sql） ---------------------------


async def test_a_value_goes_on_the_tile_in_the_form_the_map_reads(road_graph_session):
    """非該当の真偽はキーごと省く（地図は欠損を非該当として読む）。"""
    column = tile_column_sql(MaterialSpec(
        material_id="material_a", label="材料A", description="説明", dtype="boolean", tile_property="material_a",
        value_sql="em.accident_count > 0", coverage=CoverageExcluded(reason="試し", missing_semantics="definite")))

    baked = await _edge_value(road_graph_session, f"ARRAY[pg_typeof({column})::text, ({column})::text]",
                              distance_m=4000.0, accident_count=0.0)

    assert baked == ["boolean", None]


# --- 読み出しの経路（infrastructure/road_graph_repository.py） -----------------------------


async def test_a_sample_within_a_range_takes_every_way_in_it_regardless_of_the_sampling_rate(road_graph_repository):
    """`TABLESAMPLE`は表全体のページから抽選するため、狭い範囲と重ねると標本が数本へ落ちる。
    割合0は、抽選が混ざれば1本も返さない。"""
    await _ingest_ways({1: {}, 2: {}})
    area = BoundingBox(min_latitude=35.68, min_longitude=139.69, max_latitude=35.69, max_longitude=139.71)

    samples = await road_graph_repository.sample_way_material_values(1, 0.0, 10, area)

    assert len(samples) == 2


async def test_every_declared_expression_reads_only_what_each_reading_path_provides(road_graph_repository):
    """読む列が無い式が1つでもあると、その経路の読み出しは材料ぶん丸ごと落ちる。列はPostgreSQLが実行の前に
    解決するので、行が無くても確かめられる。"""
    area = BoundingBox(min_latitude=35.0, min_longitude=139.0, max_latitude=35.01, max_longitude=139.01)

    arrays = await road_graph_repository.get_edge_material_arrays([1], [0], [True], 1)
    assert len(arrays.distance_m) == 1
    assert await road_graph_repository.sample_way_material_values(1, 100.0, 10, None) == []
    assert await road_graph_repository.sample_way_material_values(1, 100.0, 10, area) == []
    assert await road_graph_repository.get_feature_landcover(1, "1-0") is None
    assert await road_graph_repository.get_feature_landcover(1, None) is None
    # 取込範囲の外なので焼かずにNoneを返すが、タイルの列は先に解決される。
    assert await road_graph_repository.get_road_surface_tile_mvt(14, 14552, 6451, area) is None
    assert await road_graph_repository.get_feature_materials_in_tile(14, 14552, 6451, area, 1) is None
