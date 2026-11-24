"""地図のフィーチャー（路面タイルの`feature_key`の単位）の材料を、鍵で道路網の配列から引くこと（`domain/road_features.py:
feature_rows`・`feature_materials`）と、そこから地図の線の層の値を配ること（`domain/road_features.py: road_layer_values`）、押した道の
小窓へ出すタイルの名前の材料（`domain/feature_materials.py: FeatureMaterials.tile_properties`）。

道路網は`tests/road_network_fixture.py`。東西に並ぶ道10（2区間）と道20（1区間）がある。

ここで見ないもの:
- 路面タイルの形と、焼いた値が鍵のフィーチャーへ載ること → `test_road_tile_sql.py`。どのフィーチャーを選ぶか →
  `test_map_features.py`
- 配列に材料を読み込むこと → `test_road_network_store.py`
"""

from datetime import datetime

import numpy as np
import pytest

from app.domain.attributes import CategoricalColumn
from app.domain.feature_materials import FeatureMaterials
from app.domain.hard_filters import HARD_FILTER_PROPERTY
from app.domain.material_catalog import ELEVATION_GAIN_PER_KM, GRADIENT_PERCENT, PEDESTRIAN_ROAD
from app.domain.road_features import feature_materials, feature_rows, road_layer_values
from app.domain.road_network_build import NetworkRegulations
from app.domain.traffic_regulation import BICYCLE_PROHIBITED, JST, RegulationSlot
from tests.road_class_fixture import classification, fact_is, map_layer, road_classes
from tests.road_network_fixture import road_network

#: 道10の2区間（東へ約91m・約273m）と、道20。どれも北緯35度の上。
_COORDINATES = {1: (35.0, 139.000), 2: (35.0, 139.001), 3: (35.0, 139.004), 4: (35.0, 139.005), 5: (35.0, 139.006)}
_SEGMENTS = {(10, 0): (1, 2), (10, 1): (2, 3), (20, 0): (4, 5)}


def _network():
    """区間ごとの数値の材料`num_a`（道10の区間は10と40、道20は値なし）と、分類の材料。道10は短い区間が`a`、長い区間が`b`、
    道20は自転車が通れない（`bicycle=no`）。"""
    by_edge = {(10, 0): (10.0, "a", None), (10, 1): (40.0, "b", None), (20, 0): (np.nan, None, "no")}

    def column(index):
        return lambda rows: [by_edge[(int(w), int(s))][index] for w, s in zip(rows.way, rows.segment, strict=True)]

    return road_network(
        _COORDINATES, _SEGMENTS, numeric={"num_a": column(0)},
        categorical={"cat_a": column(1), "bicycle": column(2)})


#: 区間で塗るズームのフィーチャー（区間）と、道1本で塗るズームのフィーチャー（道）。道99は配列に無い。
_BY_SEGMENT = (("10-0", 10, 0), ("10-1", 10, 1), ("20-0", 20, 0), ("99-0", 99, 0))
_BY_WAY = (("10", 10, None), ("20", 20, None), ("99", 99, None))


def _materials(network, features) -> FeatureMaterials:
    keys, ways, segments = zip(*features)
    return feature_materials(network, keys, *feature_rows(network, ways, segments))


def _values(materials: FeatureMaterials, material_id: str) -> dict:
    column = materials.columns[material_id]
    if isinstance(column, CategoricalColumn):
        return {key: column.value_at(row) for row, key in enumerate(materials.feature_keys)}
    return {key: None if np.isnan(value) else float(value) for key, value in zip(materials.feature_keys, column.tolist())}


def test_a_feature_painted_by_segment_has_its_segments_values():
    """区間で塗るズームは、区間ごとの値を持つ。配列に無いフィーチャーは値を持たない。"""
    materials = _materials(_network(), _BY_SEGMENT)

    assert _values(materials, "num_a") == {"10-0": 10.0, "10-1": 40.0, "20-0": None, "99-0": None}


def test_a_feature_painted_by_way_gathers_the_way_from_its_segments_by_length():
    """道1本で塗るズームの値は、区間の値を区間の長さで重みを付けて集めたもの: 数値は値のある区間の平均、分類は長さの和が一番長い
    値（値の無い区間は数えず、どの区間にも値が無ければ値無し）。"""
    network = _network()
    short, long = (float(d) for d in network.distance_m[[0, 2]])

    materials = _materials(network, _BY_WAY)

    assert _values(materials, "num_a") == pytest.approx({"10": (10 * short + 40 * long) / (short + long), "20": None,
                                                         "99": None})
    assert _values(materials, "cat_a") == {"10": "b", "20": None, "99": None}


#: 道40は東へ2区間（どちらも約91m）。区間0は両向きで10m登り、区間1は逆向き（西）にしか走れない一方通行で、東へ20m登る。
_SLOPE_COORDINATES = {6: (35.0, 139.010), 7: (35.0, 139.011), 8: (35.0, 139.012)}
_SLOPE_SEGMENTS = {(40, 0): (6, 7), (40, 1): (7, 8)}


def test_the_values_are_read_in_the_direction_the_road_is_drawn_even_where_it_runs_only_against_it():
    """地図・小窓・書き出しの値は、どれも道の向き（形の始点から終点）に走った値。逆向きにしか走れない一方通行の区間は、走れる向き
    の行しか持たないので、勾配の符号を返し、登りの量はその行の下りの量を読む——読み替えないと、東へ登る道が区間ごとに登りと下りに
    分かれて描かれ、道1本の値でも打ち消し合う。"""
    network = road_network(_SLOPE_COORDINATES, _SLOPE_SEGMENTS, backward=[(40, 1)],
                           elevation_of={(40, 0): (0.0, 10.0), (40, 1): (10.0, 30.0)},
                           numeric={ELEVATION_GAIN_PER_KM: lambda rows: np.full(len(rows.way), np.nan)})
    km = float(network.distance_m[0]) / 1000.0

    materials = _materials(network, (("40-0", 40, 0), ("40-1", 40, 1), ("40", 40, None)))

    assert _values(materials, GRADIENT_PERCENT) == pytest.approx(
        {"40-0": 1.0 / km, "40-1": 2.0 / km, "40": 1.5 / km}, rel=1e-3)
    assert _values(materials, ELEVATION_GAIN_PER_KM) == pytest.approx(
        {"40-0": 10.0 / km, "40-1": 20.0 / km, "40": 15.0 / km}, rel=1e-3)


def test_a_way_is_a_flag_where_the_longer_part_of_it_is():
    """道1本の真偽は、区間の長さの和が長い方の値（1.0か0.0）。割合のままだと、小窓は0でない値を該当として出し、区分は1.0だけを
    該当として塗るので、同じ道が小窓と地図で食い違う。"""
    lit = {(10, 0): 1.0, (10, 1): 0.0, (20, 0): 1.0}
    network = road_network(_COORDINATES, _SEGMENTS, numeric={"lit": lambda rows: [
        lit[(int(w), int(s))] for w, s in zip(rows.way, rows.segment, strict=True)]})

    materials = _materials(network, (("10", 10, None), ("20", 20, None)))

    assert _values(materials, "lit") == {"10": 0.0, "20": 1.0}


def test_a_network_without_segments_has_no_rows_for_any_feature():
    """区間を1本も持たない道路網（取込の直後）でも、フィーチャーを引くと値の無いフィーチャーになる。"""
    network = road_network({}, {})

    edge_rows, way_rows = feature_rows(network, [10, 10], [0, None])

    assert (edge_rows.tolist(), way_rows.tolist()) == ([-1, -1], [-1, -1])


def test_road_layer_values_are_served_per_feature_without_roads_outside_every_class():
    """地図は道ごとの層の値で道の線を塗り、0次ハードフィルタに当たる道を「通らない」の色で塗る。区分の外の道の層を載せると、
    地図はその道を区分の色で塗れない値として受け取る。"""
    definitions = road_classes({"k": classification({"is_a": [fact_is("cat_a", "a")]})}, map_layers={"k": map_layer()})

    keys, ways, segments = zip(*_BY_SEGMENT)
    values = road_layer_values(_network(), keys, ways, segments, definitions, None)

    assert values == {"10-0": {"k": "is_a"}, "20-0": {HARD_FILTER_PROPERTY: "no_bicycle"}}


def test_the_popup_shows_the_values_by_their_tile_names_and_only_true_flags():
    """小窓は無い値を「値なし」として読むので、値の無い材料と非該当の真偽は出さない。"""
    materials = FeatureMaterials(feature_keys=("1", "2"), columns={
        "bridge": np.array([1.0, 0.0]), "surface": CategoricalColumn.encode(["asphalt", None]),
    })

    assert [materials.tile_properties(row) for row in range(2)] == [{"bridge": True, "surface": "asphalt"}, {}]


def test_a_time_paints_the_roads_a_timed_regulation_reaches_by_the_regulations_active_then():
    """時刻を渡すと、規制の当たる道の区分はその時刻に効く規制で決まる。道10の長い区間だけに昼の規制が当たる。区間の地物はその区間の
    値、道1本の地物は区間の長さの和が一番長い値で塗る（配列を作るときと同じ集め方）。"""
    daytime = RegulationSlot(True, hours_from=8 * 60, hours_to=20 * 60)
    regulations = NetworkRegulations(
        regulation_count=1, hit_way=np.array([10]), hit_segment=np.array([1]), hit_regulation=np.array([0]),
        slot_regulation=np.array([0]), slot_values=np.array([daytime.as_values()], dtype=np.int16))
    network = road_network(_COORDINATES, _SEGMENTS, regulations=regulations,
                           categorical={PEDESTRIAN_ROAD: lambda rows: [None] * len(rows.way)})
    definitions = road_classes({"k": classification({"closed": [fact_is(PEDESTRIAN_ROAD, BICYCLE_PROHIBITED)]})},
                               map_layers={"k": map_layer()})

    def painted(hour: int) -> dict[str, dict[str, str]]:
        return road_layer_values(network, ["10-0", "10-1", "10"], [10, 10, 10], [0, 1, None], definitions,
                                 datetime(2026, 11, 24, hour, tzinfo=JST))

    assert painted(9) == {"10-1": {"k": "closed"}, "10": {"k": "closed"}}
    assert painted(21) == {}
