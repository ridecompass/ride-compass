"""地図のレンズの段の境目（1kmあたりの代償の秒）が、標準の条件でどれだけの事実に当たるかの目安。

標準の条件は、標準の人（巡航速度`domain/route_request.py: ASSUMED_SPEED_KMH`）・倍率1・つまみ1・その事実のほかは平らで舗装・
無風・止まらない1kmの道。事実の値を細かく刻んだ道を並べて費用の式（`domain/leg_costs.py: travel_inputs`と同じ走行の模型と
`domain/ledger_costs.py: LedgerCosts.penalty_by_axis`）へ通し、秒から事実の値へ引き戻す——別の換算の式を持たない。

- 登坂は一様な坂の斜度（%）、向かい風は向かい風の強さ（m/s）、停止は漕ぎ出す回数（回/km）で、段の境目ごとに引く。
  刻んだ範囲より大きい秒の境目は値なし（その範囲の外）。
- 摩擦は路面の区分ごと、道の負担の軸は区分ごと（区分の材料）か折れ点ごと（数値の材料）の秒を並べる。
"""

from collections.abc import Callable
from typing import Literal

import numpy as np

from app.domain.cost_axes import EFFORT_AXES, CategoricalBurden, CostAxisDefinitions, EffortItem
from app.domain.cycling_speed import BASE_CRR_ID, RiderProfile, SegmentSpeedModel, crr_for_surface
from app.domain.attributes import CategoricalColumn
from app.domain.elevation_profile import ElevationProfiles, GradeDistribution
from app.domain.ledger_costs import LedgerCosts, LedgerParameters
from app.domain.road_classes import CLASS_MATERIAL_PREFIX, RoadClassDefinitions, class_labels
from app.domain.route_request import ASSUMED_SPEED_KMH
from app.domain.strict_model import StrictModel
from app.domain.tuning import tuning_value

_ROAD_M = 1000.0
#: 引き戻す事実の値の刻み（最小・最大・刻み）。最大は、それより大きい事実の道がほぼ無い所に置く。
_GRADE_PERCENT = (0.0, 25.0, 0.05)
_HEADWIND_MS = (0.0, 20.0, 0.05)


class ThresholdEquivalents(StrictModel):
    """段の境目ごとの事実の値（境目と同じ並び。刻んだ範囲の外はNone）。"""

    kind: Literal["thresholds"] = "thresholds"
    fact: str
    unit: str
    values: list[float | None]


class SecondsExample(StrictModel):
    label: str
    seconds_per_km: float


class ExampleEquivalents(StrictModel):
    """事実の値ごとの1kmあたりの代償の秒（区分か折れ点の並び）。"""

    kind: Literal["examples"] = "examples"
    examples: list[SecondsExample]


LensEquivalents = ThresholdEquivalents | ExampleEquivalents


def lens_equivalents(axes: CostAxisDefinitions, parameters: LedgerParameters,
                     road_classes: RoadClassDefinitions) -> dict[str, LensEquivalents]:
    """軸id → 段の境目の目安（体力の軸をコードの表の順、続けて道の負担の軸）。"""
    result: dict[str, LensEquivalents] = {}
    for axis_id, item in EFFORT_AXES.items():
        result[axis_id] = _effort_equivalents(axes, parameters, road_classes, axis_id, item)
    for axis_id in axes.burden:
        result[axis_id] = _burden_examples(axes, parameters, road_classes, axis_id)
    return result


def _effort_equivalents(axes: CostAxisDefinitions, parameters: LedgerParameters, road_classes: RoadClassDefinitions,
                        axis_id: str, item: EffortItem) -> LensEquivalents:
    thresholds = axes.effort[axis_id].lens.thresholds

    def seconds(**road) -> np.ndarray:
        return _axis_seconds_per_km(axes, parameters, axis_id, **road)

    if item == "gravity":
        return _inverted("斜度", "%", _GRADE_PERCENT, lambda grade: seconds(grade_percent=grade), thresholds)
    if item == "air":
        return _inverted("向かい風", "m/s", _HEADWIND_MS, lambda wind: seconds(headwind_ms=wind), thresholds)
    if item == "inertia":
        one_stop = float(seconds(kickoffs=np.ones(1))[0])
        return ThresholdEquivalents(fact="止まる回数", unit="回/km",
                                    values=[threshold / one_stop if one_stop > 0 else None for threshold in thresholds])
    classification = road_classes.rolling_resistance_classification
    classes = [] if classification is None else list(road_classes.rolling_resistance_classes.get(classification, {}))
    labels = class_labels(road_classes.classifications.get(classification or ""))
    per_class = seconds(surface=CategoricalColumn.encode(classes)) if classes else np.zeros(0)
    return ExampleEquivalents(examples=[SecondsExample(label=labels.get(key, key), seconds_per_km=float(value))
                                        for key, value in zip(classes, per_class)])


def _burden_examples(axes: CostAxisDefinitions, parameters: LedgerParameters, road_classes: RoadClassDefinitions,
                     axis_id: str) -> ExampleEquivalents:
    burden = axes.burden[axis_id].burden
    if isinstance(burden, CategoricalBurden):
        labels = class_labels(road_classes.classifications.get(burden.material.removeprefix(CLASS_MATERIAL_PREFIX)))
        weights = [(labels.get(key, key), weight) for key, weight in burden.per_km.items()]
    else:
        weights = [(f"{value:g}", weight) for value, weight in burden.points]
    seconds = _axis_seconds_per_km(axes, parameters, axis_id, burden=np.array([weight for _, weight in weights]))
    return ExampleEquivalents(examples=[SecondsExample(label=label, seconds_per_km=float(value))
                                        for (label, _), value in zip(weights, seconds)])


def _inverted(fact: str, unit: str, grid: tuple[float, float, float], seconds_of: Callable[[np.ndarray], np.ndarray],
              thresholds: list[float]) -> ThresholdEquivalents:
    """事実の値を刻んで秒を求め、境目の秒に当たる事実の値を線形に引く。秒は事実の値に対して減らないよう、それまでの最大で
    ならしてから引く。"""
    low, high, step = grid
    facts = np.arange(low, high + step / 2, step)
    seconds = np.maximum.accumulate(seconds_of(facts))
    values = [float(np.interp(threshold, seconds, facts)) if seconds[0] <= threshold <= seconds[-1] else None
              for threshold in thresholds]
    return ThresholdEquivalents(fact=fact, unit=unit, values=values)


def _axis_seconds_per_km(axes: CostAxisDefinitions, parameters: LedgerParameters, axis_id: str, *,
                         grade_percent: np.ndarray | None = None, headwind_ms: np.ndarray | None = None,
                         kickoffs: np.ndarray | None = None, surface: CategoricalColumn | None = None,
                         burden: np.ndarray | None = None) -> np.ndarray:
    """標準の人が、渡した事実だけを持つ1kmの道を走ったときの、軸`axis_id`の代償の秒（道ごと）。`burden`は道の負担の軸
    `axis_id`の1kmあたりの重さ。"""
    n = len(next(v for v in (grade_percent, headwind_ms, kickoffs, surface, burden) if v is not None))
    grade = np.zeros(n) if grade_percent is None else np.asarray(grade_percent, dtype=np.float64)
    crr = np.full(n, tuning_value(BASE_CRR_ID)) if surface is None else crr_for_surface(surface)
    model = SegmentSpeedModel(RiderProfile(cruise_speed_kmh=ASSUMED_SPEED_KMH), _uniform_slopes(grade),
                              np.full(n, _ROAD_M), crr, np.zeros(n) if kickoffs is None else kickoffs)
    ledger = LedgerCosts.for_model(axes, parameters, model, {
        burden_id: burden if burden is not None and burden_id == axis_id else np.zeros(n) for burden_id in axes.burden})
    wind = np.zeros(n) if headwind_ms is None else np.asarray(headwind_ms, dtype=np.float64)
    return ledger.penalty_by_axis(model.ride(wind, np.zeros(n), parameters.effort_weight_exponent))[axis_id]


def _uniform_slopes(grade_percent: np.ndarray) -> ElevationProfiles:
    """道ごとに、始まりの0mから一様に登る2点の断面。"""
    n = len(grade_percent)
    elevation = np.column_stack([np.zeros(n), grade_percent / 100.0 * _ROAD_M]).astype(np.float32).ravel()
    return ElevationProfiles(np.arange(n, dtype=np.int64) * 2, np.full(n, 2, dtype=np.int32), np.ones(n, dtype=bool),
                             elevation, GradeDistribution(np.zeros(1), np.ones(1)))
