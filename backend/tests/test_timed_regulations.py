"""時刻で変わる交通規制を、レグの時間帯ごとに探索の範囲の区間へ当てること（`domain/timed_regulations.py`）。

見るのは、時間帯に効く規制の区間だけが区分の段で避け方を変えること、自転車も対象の規制と除外の規制が両方効く区間は倍率の大きい
側を採ること、応答の線の層の値が判定のとおりになること、路面タイルの規制の効き方がタイルに描く道の規制を全部含むこと。

ここで見ないもの:
- 組が時間帯に効くかの判断 → `test_traffic_regulation.py`
- レグの費用の合成がこの判定を読むこと → ルート生成の入口のテスト
"""

from datetime import datetime
from types import SimpleNamespace

import numpy as np

from app.domain.attributes import CategoricalColumn
from app.domain.material_catalog import PEDESTRIAN_ROAD
from app.domain.road_avoidance import AvoidanceLevel, road_avoidance_masks
from app.domain.road_classes import class_columns
from app.domain.road_network_build import NetworkRegulations
from app.domain.timed_regulations import TimedRegulations, regulated_rows_within
from app.domain.time_zone import JST
from app.domain.traffic_regulation import BICYCLE_EXCEPTED, BICYCLE_PROHIBITED, RegulationSlot
from tests.road_class_fixture import classification, fact_is, map_layer, road_classes
from tests.road_network_fixture import road_network

ROAD = "road"
DEFINITIONS = road_classes({ROAD: classification({"bicycle": [fact_is(PEDESTRIAN_ROAD, BICYCLE_PROHIBITED)],
                                                  "excepted": [fact_is(PEDESTRIAN_ROAD, BICYCLE_EXCEPTED)]})},
                           map_layers={ROAD: map_layer()})
LEVELS: dict[str, AvoidanceLevel] = {f"{ROAD}.bicycle": "exclude", f"{ROAD}.excepted": "avoid"}
MULTIPLIERS: dict[AvoidanceLevel, float] = {"pass": 1.0, "slight_prefer": 1.0, "prefer": 1.0, "slight_avoid": 1.0, "avoid": 3.0, "exclude": np.inf}
DAYTIME = RegulationSlot(True, hours_from=8 * 60, hours_to=20 * 60)
DAYTIME_EXCEPTED = RegulationSlot(False, hours_from=8 * 60, hours_to=20 * 60)


def _regulations() -> TimedRegulations:
    """区間0は自転車も対象の昼の規制、区間1は自転車は除外の昼の規制、区間2はその両方、区間3は規制が無い。区間4は組を持たない
    規制（いつでも全部の車両に効く）。"""
    network = SimpleNamespace(
        edge_regulation_count=np.array([1, 1, 2, 0, 1]), edge_regulation_start=np.array([0, 1, 2, 4, 4]),
        regulation_index=np.array([0, 1, 0, 1, 2]), regulation_slot_start=np.array([0, 1, 2]),
        regulation_slot_count=np.array([1, 1, 0]),
        regulation_slot_values=np.array([DAYTIME.as_values(), DAYTIME_EXCEPTED.as_values()], dtype=np.int16))
    facts = {PEDESTRIAN_ROAD: CategoricalColumn.empty(5)}
    base = road_avoidance_masks(class_columns(DEFINITIONS, facts, 5), LEVELS, MULTIPLIERS, 5)
    return TimedRegulations(network, np.arange(5), facts, base, np.zeros(5, dtype=bool), DEFINITIONS,  # type: ignore[arg-type]
                            LEVELS, MULTIPLIERS)


def _at(hour: int) -> datetime:
    return datetime(2026, 11, 24, hour, tzinfo=JST)


def test_only_edges_with_a_regulation_active_in_the_interval_change_their_avoidance():
    judgement = _regulations().judge(_at(9), _at(10))

    assert judgement is not None
    assert judgement.masks.excluded.tolist() == [True, False, True, False, True]
    # 両方効く区間2は、通らない側を採る。
    assert judgement.masks.cost_scale.tolist() == [1.0, 3.0, 1.0, 1.0, 1.0]
    assert [judgement.layer_values_at(row) for row in range(5)] == [
        {ROAD: "bicycle"}, {ROAD: "excepted"}, {ROAD: "bicycle"}, None, {ROAD: "bicycle"}]
    # 応答の区間の`regulation_margin`は、時刻で変わる組を効くとみなした区間（いつでも効く規制は、時刻で変わらない）。
    assert [judgement.timed_at(row) for row in range(5)] == [True, True, True, False, False]


def test_outside_the_hours_no_regulation_applies():
    judgement = _regulations().judge(_at(21), _at(22))

    assert judgement is not None
    assert (judgement.masks.excluded.tolist(), judgement.masks.cost_scale.tolist()) == (
        [False, False, False, False, True], [1.0] * 5)


def test_a_tile_keeps_the_regulations_of_every_way_drawn_on_it():
    """道1本で塗るズームのタイルは、範囲にかかる道を道の全区間の値で塗るので、規制の当たった区間が範囲の外でも、その道の規制は
    タイルの規制の効き方（持ちの印）に入る。入らないと、効き方の違う時刻どうしが同じ持ちを引き、古い色のタイルが返る。"""
    network = road_network(
        {1: (35.0, 139.000), 2: (35.0, 139.010), 3: (35.0, 139.011), 4: (35.1, 139.000), 5: (35.1, 139.001)},
        {(1, 0): (1, 2), (1, 1): (2, 3), (2, 0): (4, 5)},
        regulations=NetworkRegulations(regulation_count=2, hit_way=np.array([1, 2]), hit_segment=np.array([0, 0]),
                                       hit_regulation=np.array([0, 1]), slot_regulation=np.array([0, 1]),
                                       slot_values=np.array([DAYTIME.as_values()] * 2, dtype=np.int16)))

    # 道1の区間1だけにかかる範囲。道2は範囲の外。
    rows = regulated_rows_within(network, 139.0105, 34.999, 139.0115, 35.001)

    assert sorted({(int(network.edge_way_id[row]), int(network.edge_segment[row])) for row in rows}) == [(1, 0)]
