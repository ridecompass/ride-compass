"""`domain/map_display.py`——地図に出すものの束ね方（グループ・種別・情報源・レイヤー）の宣言。

入口は`map_layer_label`（レイヤーの名前）・説明の文を宣言から組む`size_sentence`・宣言どうしが名前（`key`）で指し合う先を
確かめる`check_map_layer_declarations`・ズームの曲線を組む`zoom_curve`。描く寸法の値そのものは見ない（宣言の書き写しになる）。
文を組む関数と検査には架空の行・宣言を渡す（本番の宣言は読み込みの時点で検査を通る）。

ここで見ないもの:
- 気象の要素の宣言（チップ・名前付きソース・コマの規則）と予測が届く先の語 → `test_weather_elements.py`
- 一次属性の行の色と、値の無い道の線が地色から見えること → `test_display_palette.py`
- 一次属性の表示の行の宣言 → `test_registry.py`・`test_primary_attributes.py`
- 宣言を生成物へ書き出すこと → `scripts/export_openapi.py`の生成物のドリフト検査
- 説明の差し込み口を軸カタログの値で埋めること → frontend `mapLayers.test.ts`
"""

import pytest

from app.domain import map_display
from app.domain.map_display import MapLayerSpec, map_layer_label, size_sentence
from app.domain.registry import DisplayAxisSpec, DisplayCategorySpec


def axis(*rows: tuple[str, int | None]) -> DisplayAxisSpec:
    """架空の行（名前・半径）を並べた見方。"""
    return DisplayAxisSpec(
        key="axis",
        property="prop",
        palette=None,
        categories=tuple(
            DisplayCategorySpec(key=f"k{i}", label=label, values=(f"v{i}",), description="架空の行", radius_px=radius)
            for i, (label, radius) in enumerate(rows)
        ),
    )


@pytest.mark.parametrize(
    ("rows", "named"),
    [([("重い", 6), ("軽い", 3)], "重い"), ([("重い", 3), ("軽い", 6)], "軽い")],
    ids=["先頭が大きい", "半径を入れ替えた"],
)
def test_the_size_sentence_names_the_row_drawn_largest(rows, named):
    """半径の宣言を入れ替えて文が追従しないと、説明が小さく描く方を「大きく表示」と書く。"""
    assert size_sentence(axis(*rows)) == f"{named}は円を大きく表示します。"


@pytest.mark.parametrize("rows", [[("重い", 4), ("軽い", 4)], [("重い", 6), ("軽い", None)]], ids=["同じ半径", "半径の無い行"])
def test_the_size_sentence_is_refused_when_the_rows_are_not_told_apart_by_size(rows):
    """大きさで分けていない見方に「大きく表示」と書かない。"""
    with pytest.raises(ValueError, match="違う半径"):
        size_sentence(axis(*rows))


def test_a_layer_drawing_a_primary_attribute_takes_the_name_of_the_attribute():
    attribute = next(attr for attr in map_display.PRIMARY_ATTRIBUTES if attr.display_axes)

    assert map_layer_label(attribute.attr_id, MapLayerSpec("road_surface", None)) == attribute.label


def test_a_layer_without_any_name_is_refused():
    with pytest.raises(ValueError, match="名前が無い"):
        map_layer_label("not_an_attribute", MapLayerSpec("ownFetch", None))


G = map_display.OverlayGroup
C = map_display.LayerCategory
S = map_display.MapLayerDataSource


def _layer(source="s", category="c") -> MapLayerSpec:
    return MapLayerSpec(source, category)


@pytest.mark.parametrize(
    ("groups", "categories", "sources", "specs"),
    [
        pytest.param((G("g", "群"), G("g", "群")), (C("c", "g"),), (S("s"),), (_layer(),), id="グループの名前が重なる"),
        pytest.param((G("g", "群"),), (C("c", "g"), C("c", "g")), (S("s"),), (_layer(),), id="種別の名前が重なる"),
        pytest.param((G("g", "群"),), (C("c", "g"),), (S("s"), S("s")), (_layer(),), id="情報源の名前が重なる"),
        pytest.param((G("g", "群"),), (C("c", "g"), C("d", "h")), (S("s"),), (_layer(),), id="宣言に無いグループ"),
        pytest.param((G("g", "群"), G("h", "空")), (C("c", "g"),), (S("s"),), (_layer(),), id="種別の無いグループ"),
        pytest.param((G("g", "群"),), (C("c", "g"),), (S("s"),), (_layer(category="d"),), id="宣言に無い種別"),
        pytest.param((G("g", "群"),), (C("c", "g"),), (S("s"),), (_layer(source="t"),), id="宣言に無い情報源"),
    ],
)
def test_declarations_pointing_to_no_single_name_are_refused(groups, categories, sources, specs):
    """指した先が無いレイヤーは取得状態を判定できず一覧に出ない。名前が2つあると指した側は一方だけを読み、空のチップは押しても何も出ない。"""
    with pytest.raises(ValueError):
        map_display.check_map_layer_declarations(groups, categories, sources, specs)


def test_declarations_pointing_to_single_names_are_accepted():
    map_display.check_map_layer_declarations(
        (G("g", "群"),), (C("c", "g"),), (S("s"),), (_layer(), MapLayerSpec("s", None)))


@pytest.mark.parametrize("stops", [(), ((10, 1), (10, 2)), ((13, 1), (10, 2))], ids=["空", "同じズーム", "降順"])
def test_a_zoom_curve_not_strictly_ascending_is_refused(stops):
    """地図の式（MapLibreの`interpolate`・`step`）は入力の段が厳密に昇順でないと式ごと失敗し、レイヤーが黙って消える。"""
    with pytest.raises(ValueError, match="厳密に昇順"):
        map_display.zoom_curve(*stops)


def test_a_zoom_curve_strictly_ascending_is_kept_as_given():
    assert map_display.zoom_curve((10, 2), (13, 1)) == ((10, 2), (13, 1))
