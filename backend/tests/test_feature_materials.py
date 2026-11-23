"""地図のフィーチャー（路面タイルの`feature_key`の単位）の材料を、鍵で道路網の配列から引くこと（`domain/road_network.py:
feature_rows`・`feature_materials`）と、そこから地図の線の層の値を配ること（`services/region_service.py: road_layer_values`）、押した道の
小窓へ出すタイルの名前の材料（`domain/feature_materials.py: FeatureMaterials.tile_properties`）。

道路網は`tests/road_network_fixture.py`。東西に並ぶ道10（2区間）と道20（1区間）と、区間を持たない道30がある。

ここで見ないもの:
- 路面タイルの形と、焼いた値が鍵のフィーチャーへ載ること → `test_road_tile_sql.py`。タイルのフィーチャーの鍵が配列と噛み合うこと →
  `test_feature_materials_in_tile.py`
- 配列に材料を読み込むこと → `test_road_network_store.py`
"""

import numpy as np
import pytest

from app.domain.attributes import CategoricalColumn
from app.domain.feature_materials import FeatureMaterials
from app.domain.hard_filters import HARD_FILTER_PROPERTY
from app.domain.road_network import feature_materials, feature_rows
from app.domain.road_network_build import EdgelessWays
from app.services.region_service import road_layer_values
from tests.road_class_fixture import classification, fact_is, map_layer, road_classes
from tests.road_network_fixture import road_network

#: 道10の2区間（東へ約91m・約273m）、道20、区間を持たない道30。どれも北緯35度の上。
_COORDINATES = {1: (35.0, 139.000), 2: (35.0, 139.001), 3: (35.0, 139.004), 4: (35.0, 139.005), 5: (35.0, 139.006)}
_SEGMENTS = {(10, 0): (1, 2), (10, 1): (2, 3), (20, 0): (4, 5)}
_EDGELESS_WAY = 30


def _network():
    """区間ごとの数値の材料`num_a`（道10の区間は10と40、道20は値なし）と、分類の材料。道10は短い区間が`a`、長い区間が`b`、
    道20は自転車が通れない（`bicycle=no`）。区間を持たない道30は、`num_a`が7で`cat_a`が`a`。"""
    by_edge = {(10, 0): (10.0, "a", None), (10, 1): (40.0, "b", None), (20, 0): (np.nan, None, "no")}

    def column(index):
        return lambda rows: [by_edge[(int(w), int(s))][index] for w, s in zip(rows.way, rows.segment, strict=True)]

    edgeless = EdgelessWays(
        osm_way_id=np.array([_EDGELESS_WAY]), numeric_values=np.array([[7.0, np.nan]]),
        categorical_codes=np.array([[1, 0]], dtype=np.int16))
    return road_network(
        _COORDINATES, _SEGMENTS, numeric={"num_a": column(0)},
        categorical={"cat_a": column(1), "bicycle": column(2)},
        edgeless=edgeless)


#: 区間で塗るズームのフィーチャー（区間と、区間を持たない道）と、道1本で塗るズームのフィーチャー（道）。道99は配列に無い。
_BY_SEGMENT = (("10-0", 10, 0), ("10-1", 10, 1), ("20-0", 20, 0), ("30", 30, None), ("99-0", 99, 0))
_BY_WAY = (("10", 10, None), ("20", 20, None), ("30", 30, None), ("99", 99, None))


def _materials(network, features) -> FeatureMaterials:
    keys, ways, segments = zip(*features)
    return feature_materials(network, keys, *feature_rows(network, ways, segments))


def _values(materials: FeatureMaterials, material_id: str) -> dict:
    column = materials.columns[material_id]
    if isinstance(column, CategoricalColumn):
        return {key: column.value_at(row) for row, key in enumerate(materials.feature_keys)}
    return {key: None if np.isnan(value) else float(value) for key, value in zip(materials.feature_keys, column.tolist())}


def test_a_feature_painted_by_segment_has_its_segments_values_and_a_way_without_segments_has_the_ways():
    """区間で塗るズームは、区間ごとの値と、区間を持たない道1本の値を持つ（区間を持たない道を落とすと、拡大したときだけその道が
    地図から消える）。配列に無いフィーチャーは値を持たない。"""
    materials = _materials(_network(), _BY_SEGMENT)

    assert _values(materials, "num_a") == {"10-0": 10.0, "10-1": 40.0, "20-0": None, "30": 7.0, "99-0": None}


def test_a_feature_painted_by_way_gathers_the_way_from_its_segments_by_length():
    """道1本で塗るズームの値は、区間の値を区間の長さで重みを付けて集めたもの: 数値は値のある区間の平均、分類は長さの和が一番長い
    値（値の無い区間は数えず、どの区間にも値が無ければ値無し）。"""
    network = _network()
    short, long = (float(d) for d in network.distance_m[[0, 2]])

    materials = _materials(network, _BY_WAY)

    assert _values(materials, "num_a") == pytest.approx({"10": (10 * short + 40 * long) / (short + long), "20": None,
                                                         "30": 7.0, "99": None})
    assert _values(materials, "cat_a") == {"10": "b", "20": None, "30": "a", "99": None}


def test_road_layer_values_are_served_per_feature_without_roads_outside_every_class():
    """地図は道ごとの層の値で道の線を塗り、0次ハードフィルタに当たる道を「通らない」の色で塗る。区分の外の道の層を載せると、
    地図はその道を区分の色で塗れない値として受け取る。"""
    definitions = road_classes({"k": classification({"is_a": [fact_is("cat_a", "a")]})}, map_layers={"k": map_layer()})

    keys, ways, segments = zip(*_BY_SEGMENT)
    values = road_layer_values(_network(), keys, ways, segments, definitions)

    assert values == {"10-0": {"k": "is_a"}, "20-0": {HARD_FILTER_PROPERTY: "no_bicycle"}, "30": {"k": "is_a"}}


def test_the_popup_shows_the_values_by_their_tile_names_and_only_true_flags():
    """小窓は無い値を「値なし」として読むので、値の無い材料と非該当の真偽は出さない。"""
    materials = FeatureMaterials(feature_keys=("1", "2"), columns={
        "bridge": np.array([1.0, 0.0]), "surface": CategoricalColumn.encode(["asphalt", None]),
    })

    assert [materials.tile_properties(row) for row in range(2)] == [{"bridge": True, "surface": "asphalt"}, {}]
