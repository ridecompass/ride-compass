"""地図のレンズの色の物差し（緑の端と一番濃い赤の端を、軸の事実の値で持つ。`domain/cost_axes.py: LensScale`）を、事実の値で刻んだ段
（境目は1kmあたりの代償の秒）へ読み替える。段の名前は、数で言える事実の値の範囲（「10%以上」）だけを付け、区分の軸と総合には付けない
（地図は色で負担の大小を見せ、色の理由を文で言わない）。

条件は、標準の人（巡航速度`domain/route_request.py: ASSUMED_SPEED_KMH`）・標準の利用者の値（つまみと倍率）・その事実のほかは平らで
舗装・無風・止まらない1kmの道。事実の値の道を費用の式（`domain/leg_costs.py: travel_inputs`と同じ走行の模型と
`domain/ledger_costs.py: LedgerCosts.penalty_by_axis`）へ通して秒を求める——別の換算の式を持たない。

- 登坂は一様な坂の斜度（%）、向かい風は向かい風の強さ（m/s）、停止は漕ぎ出す回数（回/km）、数値の材料の道のストレスの軸は材料の値、
  総合は秒そのもので、緑の端から赤の端までを等分に刻む（秒は事実に比例しないので、事実の値で均等に色が変わるよう、刻みごとに境目を置く）。
- 路面の抵抗と区分の材料の道のストレスの軸は、緑の端の区分から赤の端の区分までの区分の秒に境目を置く。
- 物差しの無い軸（物差しを書く前の定義）は、定義の段をそのまま使う。
"""

from collections.abc import Callable

import numpy as np

from app.domain.attributes import CategoricalColumn
from app.domain.axis_templates import evaluate_breakpoint_linear
from app.domain.cost_axes import EFFORT_AXES, AxisPresentation, CategoricalBurden, LensBands, LensScale
from app.domain.cost_preference import CostPreference
from app.domain.cycling_speed import STANDARD_TEMPERATURE_C, RiderProfile, SegmentSpeedModel, crr_for_surface
from app.domain.elevation_profile import FLAT, ElevationProfiles, along_fractions
from app.domain.ledger_costs import LedgerCosts, LedgerParameters, ledger_parameters
from app.domain.lens_total import TOTAL_LENS_ID
from app.domain.material_catalog import MATERIAL_CATALOG
from app.domain.model_settings import ModelSettings
from app.domain.route_request import ASSUMED_SPEED_KMH
from app.domain.tuning import BASE_CRR_ID

_ROAD_M = 1000.0
#: 緑の端から赤の端までの刻みの数。
_STEPS = 10

#: 物差し → 段。
_Facts = Callable[[LensScale], LensBands]


def lens_bands(settings: ModelSettings) -> dict[str, LensBands]:
    """レンズid（総合と軸id）→ 地図のレンズの段。"""
    axes, road_classes = settings.cost_axes, settings.road_classes
    parameters = ledger_parameters(CostPreference(), settings.tuning)

    def seconds_of(axis_id: str) -> Callable[..., np.ndarray]:
        return lambda **road: _axis_seconds_per_km(settings, parameters, axis_id, **road)

    # 総合の秒は利用者に伝わる事実ではないので、段に名前を付けない（色だけで見せる）。
    result = {TOTAL_LENS_ID: _unnamed(_bands_of(axes.total_lens, lambda scale: _numeric(scale, "", lambda v: v)))}
    for axis_id, item in EFFORT_AXES.items():
        seconds = seconds_of(axis_id)
        facts: _Facts
        if item == "gravity":
            facts = lambda scale: _numeric(scale, "%", lambda v: seconds(grade_percent=v))  # noqa: E731
        elif item == "air":
            facts = lambda scale: _numeric(scale, "m/s", lambda v: seconds(headwind_ms=v))  # noqa: E731
        elif item == "inertia":
            facts = lambda scale: _numeric(scale, "回/km", lambda v: seconds(kickoffs=v))  # noqa: E731
        else:
            classification = road_classes.rolling_resistance_classification or ""
            keys = list(road_classes.rolling_resistance_classes.get(classification, {}))
            per_key = seconds(surface=CategoricalColumn.encode(keys)) if keys else np.zeros(0)
            facts = lambda scale: _classes(scale, keys, per_key)  # noqa: E731
        result[axis_id] = _bands_of(axes.effort[axis_id], facts)
    for axis_id, axis in axes.burden.items():
        burden, seconds = axis.burden, seconds_of(axis_id)
        if isinstance(burden, CategoricalBurden):
            keys = list(burden.per_km)
            per_key = seconds(burden=np.array([burden.per_km[key] for key in keys], dtype=np.float64))
            facts = lambda scale: _classes(scale, keys, per_key)  # noqa: E731
        else:
            spec = MATERIAL_CATALOG.get(burden.material)
            points = burden.points
            facts = lambda scale: _numeric(  # noqa: E731
                scale, spec.unit if spec else "", lambda v: seconds(burden=evaluate_breakpoint_linear(v, points)))
        result[axis_id] = _bands_of(axis, facts)
    return result


def _bands_of(presentation: AxisPresentation, facts: _Facts) -> LensBands:
    if presentation.scale is not None:
        return facts(presentation.scale)
    if presentation.lens is None:
        raise ValueError("色の物差しも段も無い見せ方")  # 定義の型が、どちらかを要る
    return presentation.lens


def _numeric(scale: LensScale, unit: str, seconds_of: Callable[[np.ndarray], np.ndarray]) -> LensBands:
    """緑の端から赤の端までを`_STEPS`に等分した事実の値（緑の端を除く）ごとに境目を置いた段（名前は事実の値の範囲）。"""
    ticks = np.linspace(float(scale.green), float(scale.red), _STEPS + 1)
    seconds = np.maximum.accumulate(np.asarray(seconds_of(ticks), dtype=np.float64))
    text = [f"{round(float(value), 1):g}" for value in ticks]
    # 緑の端より小さい値は最初の段（一番緑）に入れ、赤の端より大きい値は最後の段（一番赤）に入れる。名前は軸の名前を繰り返さない。
    names = [f"{text[1]}{unit}未満"] + [f"{low}〜{high}{unit}" for low, high in zip(text[1:], text[2:])] \
        + [f"{text[-1]}{unit}以上"]
    return _distinct([float(value) for value in seconds[1:]], names)


def _classes(scale: LensScale, keys: list[str], seconds: np.ndarray) -> LensBands:
    """緑の端の区分から赤の端の区分までの区分の秒に境目を置いた、名前の無い段（同じ秒の区分は同じ段。端より軽い・重い区分は
    端の段）。"""
    by_key = dict(zip(keys, (float(value) for value in seconds), strict=True))
    low, high = sorted((by_key[str(scale.green)], by_key[str(scale.red)]))
    values = sorted({min(max(value, low), high) for value in by_key.values()})
    return LensBands(thresholds=values[1:], band_labels=[""] * len(values))


def _unnamed(bands: LensBands) -> LensBands:
    return LensBands(thresholds=bands.thresholds, band_labels=[""] * len(bands.band_labels))


def _distinct(thresholds: list[float], names: list[str]) -> LensBands:
    """境目が前の境目と同じ秒の段を、前の段へまとめる（段の境目は昇順に並べる）。`names`は境目より1つ多い。"""
    kept_thresholds: list[float] = []
    kept_names = [names[0]]
    for threshold, name in zip(thresholds, names[1:], strict=True):
        if kept_thresholds and threshold <= kept_thresholds[-1]:
            kept_names[-1] = name  # まとめた段は上の側の名前で呼ぶ（一番濃い段は「…以上」のまま）
            continue
        kept_thresholds.append(threshold)
        kept_names.append(name)
    return LensBands(thresholds=kept_thresholds, band_labels=kept_names)


def _axis_seconds_per_km(settings: ModelSettings, parameters: LedgerParameters, axis_id: str, *,
                         grade_percent: np.ndarray | None = None, headwind_ms: np.ndarray | None = None,
                         kickoffs: np.ndarray | None = None, surface: CategoricalColumn | None = None,
                         burden: np.ndarray | None = None) -> np.ndarray:
    """標準の人が、渡した事実だけを持つ1kmの道を走ったときの、軸`axis_id`の代償の秒（道ごと）。`burden`は道のストレスの軸
    `axis_id`の1kmあたりの重さ。"""
    n = len(next(v for v in (grade_percent, headwind_ms, kickoffs, surface, burden) if v is not None))
    grade = np.zeros(n) if grade_percent is None else np.asarray(grade_percent, dtype=np.float64)
    tuning, axes = settings.tuning, settings.cost_axes
    crr = (np.full(n, tuning.value(BASE_CRR_ID)) if surface is None
           else crr_for_surface(surface, settings.road_classes, tuning))
    model = SegmentSpeedModel(RiderProfile.standard(ASSUMED_SPEED_KMH, tuning), _uniform_slopes(grade),
                              np.full(n, _ROAD_M), crr, np.zeros(n) if kickoffs is None else kickoffs, tuning)
    ledger = LedgerCosts.for_model(axes, parameters, model, {
        burden_id: burden if burden is not None and burden_id == axis_id else np.zeros(n) for burden_id in axes.burden})
    wind = np.zeros(n) if headwind_ms is None else np.asarray(headwind_ms, dtype=np.float64)
    return ledger.row_seconds(model, wind, np.zeros(n), np.full(n, STANDARD_TEMPERATURE_C))[1][axis_id]


def _uniform_slopes(grade_percent: np.ndarray) -> ElevationProfiles:
    """道ごとに、一様に登る2点の断面。標高の平均を海面（0m）に置く（空気を坂の大きさで変えない）。"""
    n = len(grade_percent)
    rise = grade_percent / 100.0 * _ROAD_M
    elevation = np.column_stack([-rise / 2, rise / 2]).astype(np.float32).ravel()
    return ElevationProfiles(np.arange(n, dtype=np.int64) * 2, np.full(n, 2, dtype=np.int32), np.ones(n, dtype=bool),
                             elevation, np.tile(along_fractions((), 2), n), FLAT)
