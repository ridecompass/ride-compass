"""`infrastructure/point_tile_layers.py`——点のレイヤーの宣言と、そこから組み立てるもの。

確かめるのは、点の一次属性を配らない・source-layer名が重なる宣言を断ること（`check_point_tile_layers`へ架空の宣言を渡す。
本番の宣言は読み込みの時点でこれを通る）と、レイヤーの世代が自分のSQLとsource-layer名だけに従うこと。

ここで見ないもの:
- 焼き込むSQLが出す点 → `test_point_tiles.py`
- 配信（キャッシュ・空タイル・未知のレイヤーの404） → `test_region_service.py`・`test_region_routes.py`
- 世代の文字列の組み立て → `test_derived_data_revision_service.py`
"""

import dataclasses

import pytest
from sqlalchemy import text

from app.domain.registry import PrimaryAttributeSpec
from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS, PointTileLayer, check_point_tile_layers
from app.infrastructure.vector_tile import ROAD_SURFACE_LAYER_NAME


def _layer(name="poi", source_layer="points") -> PointTileLayer:
    return PointTileLayer(name=name, source_layer=source_layer, sql=text("SELECT 1"))


_POINT = PrimaryAttributeSpec(attr_id="p", label="点", geometry="point", tile_kind="poi")


@pytest.mark.parametrize(
    ("layers", "attributes"),
    [
        pytest.param({"accident": _layer("accident")}, (_POINT,), id="点の属性が指す系統が無い"),
        pytest.param({"poi": _layer(source_layer=ROAD_SURFACE_LAYER_NAME)}, (), id="道路のタイルと同じsource-layer名"),
        pytest.param({"poi": _layer(), "accident": _layer("accident")}, (), id="点のレイヤーどうしで同じsource-layer名"),
    ],
)
def test_layers_that_do_not_serve_points_one_way_are_refused(layers, attributes):
    with pytest.raises(ValueError):
        check_point_tile_layers(layers, attributes)


def test_layers_serving_points_one_way_are_accepted():
    check_point_tile_layers({"poi": _layer(), "accident": _layer("accident", "accidents")}, (_POINT,))


def test_a_layers_generation_follows_only_its_own_sql_and_source_layer():
    """世代はレイヤーごとに独立している。1つのSQLを変えて作り直すとき、他のレイヤーのキャッシュを捨てない。
    source-layer名を変えたタイルを古い鍵で配ると、画面が新しい名前のレイヤーを見つけられない。"""
    layer = next(iter(POINT_TILE_LAYERS.values()))

    assert dataclasses.replace(layer, sql=text(f"{layer.sql.text} -- changed")).shape != layer.shape
    assert dataclasses.replace(layer, source_layer=f"{layer.source_layer}_renamed").shape != layer.shape
