"""`domain/landcover.py`——道の周りの土地被覆の画素数を、クラスごとの割合へ変える。

入口は次のとおり。
- `class_percentages_sql`: 区間ごとのクラス別の画素数から割合の行を返すSQL（PostGISで実行して確かめる）
- `LandcoverPercentages`: その行を受け取るモデル
- `check_landcover_classes`: クラスの宣言を、読む所のどこでも1つのクラスに決まらなければ断る（架空の宣言で見る。本番の宣言は読み込みの時点でこれを通る）

ここで見ないもの:
- 道の周りの帯から画素を数えること → `test_derive_landcover.py`
- ラスタを読んでタイルを塗ること → `test_landcover_raster.py`
- どのクラスが難易度に効くか（評価軸の項）→ 軸の宣言のテスト
- 割合列の名前から材料の列の名前を導く規則（`landcover_key`）→ 書く側も読む側も
  同じ関数で名前を導くので、食い違いようが無い
"""

import pytest
from sqlalchemy import text

from app.domain import landcover



#: SQLを実行するテストにだけ付ける（接続とイベントループをファイルで共有する。testing-backend.md パターン2）。
on_postgis = pytest.mark.asyncio(loop_scope="module")

# 配布元の画素値のうち、どのクラスでもないもの（No Data と Clouds）。
NO_DATA = 0
CLOUDS = 10

CLASS_VALUES = [value for _, value in landcover.PERCENT_CLASSES]
FIRST, SECOND = CLASS_VALUES[0], CLASS_VALUES[1]


def field_of(value: int) -> str:
    return next(cls.percent_field for cls in landcover.LANDCOVER_CLASSES if cls.value == value)


async def percentages(session, counts: list[tuple[int, int, int, int]]) -> list[dict]:
    """`(osm_way_id, segment_index, cls, n)`の行を関係として渡し、返った行を辞書で返す。"""
    rows = ", ".join(f"({way}, {segment}, {cls}, {n})" for way, segment, cls, n in counts)
    relation = f"SELECT * FROM (VALUES {rows}) AS c(osm_way_id, segment_index, cls, n)"
    result = await session.execute(text(landcover.class_percentages_sql(relation)))
    return [dict(row._mapping) for row in result]


@on_postgis
async def test_no_data_and_clouds_are_left_out_of_the_denominator(road_graph_session):
    [row] = await percentages(
        road_graph_session, [(1, 0, FIRST, 30), (1, 0, NO_DATA, 500), (1, 0, CLOUDS, 500)]
    )

    assert row["valid_pixels"] == 30
    assert row[field_of(FIRST)] == pytest.approx(100.0)


@on_postgis
async def test_a_segment_with_too_few_valid_pixels_has_no_row(road_graph_session):
    enough = landcover.MIN_VALID_PIXELS
    rows = await percentages(
        road_graph_session,
        [
            (1, 0, FIRST, enough),  # ちょうど下限は行を持つ
            (2, 0, FIRST, enough - 1),
        ],
    )

    assert [row["osm_way_id"] for row in rows] == [1]


@on_postgis
async def test_segments_are_counted_separately(road_graph_session):
    rows = await percentages(
        road_graph_session,
        [(1, 0, FIRST, 20), (1, 1, SECOND, 20), (2, 0, FIRST, 10), (2, 0, SECOND, 30)],
    )

    by_segment = {(row["osm_way_id"], row["segment_index"]): row for row in rows}
    assert by_segment[(1, 0)][field_of(FIRST)] == pytest.approx(100.0)
    assert by_segment[(1, 1)][field_of(SECOND)] == pytest.approx(100.0)
    assert by_segment[(2, 0)][field_of(FIRST)] == pytest.approx(25.0)


@on_postgis
async def test_every_class_in_the_declaration_is_counted_and_the_row_fits_the_model(road_graph_session):
    """クラスごとに違う画素数を与え、どのクラスの数もそのクラスの列にだけ入ることを見る。画素の無いクラスは0。"""
    counts = {value: 10 * (position + 1) for position, value in enumerate(CLASS_VALUES[:-1])}
    [row] = await percentages(road_graph_session, [(1, 0, value, n) for value, n in counts.items()])
    total = sum(counts.values())

    percentages_row = landcover.LandcoverPercentages(
        **{name: value for name, value in row.items() if name not in ("osm_way_id", "segment_index", "valid_pixels")}
    )

    for cls in landcover.LANDCOVER_CLASSES:
        assert getattr(percentages_row, cls.percent_field) == pytest.approx(100.0 * counts.get(cls.value, 0) / total)


def _class(value=1, field="a_percent", label="甲", color="#000001", description="d") -> landcover.LandcoverClass:
    return landcover.LandcoverClass(value, field, label, color, description)


@pytest.mark.parametrize(
    "classes",
    [
        pytest.param((_class(), _class(field="b_percent", label="乙", color="#000002")), id="画素値が重なる"),
        pytest.param((_class(), _class(value=2, label="乙", color="#000002")), id="割合列が重なる"),
        pytest.param((_class(), _class(value=2, field="b_percent", color="#000002")), id="表示名が重なる"),
        pytest.param((_class(), _class(value=2, field="b_percent", label="乙")), id="色が重なる"),
        pytest.param((_class(field="a"),), id="割合列が接尾辞で終わらない"),
        pytest.param((_class(value=CLOUDS),), id="どのクラスでもない画素値"),
        pytest.param((_class(description=" "),), id="説明が空"),
    ],
)
def test_classes_that_cannot_be_told_apart_where_read_are_refused(classes):
    with pytest.raises(ValueError, match="土地被覆"):
        landcover.check_landcover_classes(classes)
