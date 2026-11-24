"""時刻で変わる交通規制を、レグの時間帯ごとに探索の範囲の区間へ当てること（`domain/timed_regulations.py`）。

見るのは、時間帯に効く規制の区間だけが区分の段で避け方を変えること、自転車も対象の規制と除外の規制が両方効く区間は倍率の大きい
側を採ること、応答の線の層の値が判定のとおりになること。

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
from app.domain.timed_regulations import TimedRegulations
from app.domain.traffic_regulation import BICYCLE_EXCEPTED, BICYCLE_PROHIBITED, JST, RegulationSlot
from tests.road_class_fixture import classification, fact_is, map_layer, road_classes

ROAD = "road"
DEFINITIONS = road_classes({ROAD: classification({"bicycle": [fact_is(PEDESTRIAN_ROAD, BICYCLE_PROHIBITED)],
                                                  "excepted": [fact_is(PEDESTRIAN_ROAD, BICYCLE_EXCEPTED)]})},
                           map_layers={ROAD: map_layer()})
LEVELS: dict[str, AvoidanceLevel] = {f"{ROAD}.bicycle": "exclude", f"{ROAD}.excepted": "avoid"}
MULTIPLIERS: dict[AvoidanceLevel, float] = {"pass": 1.0, "slight_prefer": 1.0, "prefer": 1.0, "slight_avoid": 1.0, "avoid": 3.0, "exclude": np.inf}
DAYTIME = RegulationSlot(True, hours_from=8 * 60, hours_to=20 * 60)
DAYTIME_EXCEPTED = RegulationSlot(False, hours_from=8 * 60, hours_to=20 * 60)


def _regulations() -> TimedRegulations:
    """区間0は自転車も対象の昼の規制、区間1は自転車は除外の昼の規制、区間2はその両方、区間3は規制が無い。"""
    network = SimpleNamespace(
        edge_regulation_count=np.array([1, 1, 2, 0]), edge_regulation_start=np.array([0, 1, 2, 4]),
        regulation_index=np.array([0, 1, 0, 1]), regulation_slot_start=np.array([0, 1]),
        regulation_slot_count=np.array([1, 1]),
        regulation_slot_values=np.array([DAYTIME.as_values(), DAYTIME_EXCEPTED.as_values()], dtype=np.int16))
    facts = {PEDESTRIAN_ROAD: CategoricalColumn.empty(4)}
    base = road_avoidance_masks(class_columns(DEFINITIONS, facts, 4), LEVELS, MULTIPLIERS, 4)
    return TimedRegulations(network, np.arange(4), facts, base, np.zeros(4, dtype=bool), DEFINITIONS,  # type: ignore[arg-type]
                            LEVELS, MULTIPLIERS)


def _at(hour: int) -> datetime:
    return datetime(2026, 11, 24, hour, tzinfo=JST)


def test_only_edges_with_a_regulation_active_in_the_interval_change_their_avoidance():
    judgement = _regulations().judge(_at(9), _at(10))

    assert judgement is not None
    assert judgement.masks.excluded.tolist() == [True, False, True, False]
    # 両方効く区間2は、通らない側を採る。
    assert judgement.masks.cost_scale.tolist() == [1.0, 3.0, 1.0, 1.0]
    assert [judgement.layer_values_at(row) for row in range(4)] == [
        {ROAD: "bicycle"}, {ROAD: "excepted"}, {ROAD: "bicycle"}, None]


def test_outside_the_hours_no_regulation_applies():
    judgement = _regulations().judge(_at(21), _at(22))

    assert judgement is not None
    assert (judgement.masks.excluded.tolist(), judgement.masks.cost_scale.tolist()) == ([False] * 4, [1.0] * 4)
