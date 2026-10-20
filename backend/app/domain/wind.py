import math
from dataclasses import dataclass
from datetime import datetime

import numpy as np

from app.domain.geo import haversine_distance_km, haversine_distance_km_array
from app.domain.msm import MsmBlock
from app.domain.route import Coordinates
from app.domain.way_value_formula import (
    FALSE,
    FormulaNode,
    Round,
    Unary,
    WayValueFormula,
    add,
    condition,
    const,
    div,
    evaluate_formula,
    feature,
    mul,
    sub,
)

#: 出発時の風（`DepartureWind`）の風速・風向を応答に載せる桁。
DEPARTURE_WIND_DECIMALS = 1
#: 風の材料（向かい風の抗力比）を地図へ配る桁。
WIND_DRAG_RATIO_DECIMALS = 3

# 道なり距離／直線距離の比の想定値。探索前に各Edgeの通過予定時刻を「基準点からの直線距離
# ×この比÷仮定速度」で推定するときに使う。風の時間解像度は1時間のため、この比のばらつきに
# よる推定誤差は同じビンへ収まる程度で足りる。
ROUTE_DETOUR_RATIO = 1.3

#: 時速（km/h）を秒速（m/s）へ直す割る数。
KMH_PER_MS = 3.6


def kmh_to_ms(speed_kmh: float) -> float:
    return speed_kmh / KMH_PER_MS


def detour_ratio_or_default(learned: float | None) -> float:
    """レグの時刻の推定に使う迂回率。探索範囲の学習値があればそれ、無ければ`ROUTE_DETOUR_RATIO`。"""
    return learned if learned is not None else ROUTE_DETOUR_RATIO


def is_usable_detour_ratio(measured: float) -> bool:
    """実測の迂回率を学習値・到着予定時刻に使ってよいか（NaN・非正は使わない）。"""
    return math.isfinite(measured) and measured > 0


# 風の追加負荷（`wind_drag_ratio_array`）を無次元化する基準速度（m/s、時速20km）。
# `domain/route_request.py: ASSUMED_SPEED_KMH`とは独立の専用定数にする——既定の想定速度を変えても材料のスケール
# （軸スタジオのbreakpointsが前提にする値域）がずれないようにするため。
WIND_DRAG_REFERENCE_SPEED_KMH = 20.0
WIND_DRAG_REFERENCE_SPEED_MS = kmh_to_ms(WIND_DRAG_REFERENCE_SPEED_KMH)


def wind_component_formulas(
    wind_speed_ms: FormulaNode, wind_direction_deg: FormulaNode, travel_bearing_deg: FormulaNode
) -> tuple[FormulaNode, FormulaNode]:
    """風を進行方向の成分（正が向かい風）と横成分へ分解する木（m/s）。"""
    # wind_direction_degは気象学の慣習で「風が吹いてくる方向」。走行方位との差が0で
    # 正面からの向かい風、180で背後からの追い風。
    angle = mul(sub(wind_direction_deg, travel_bearing_deg), const(math.pi / 180))
    return mul(wind_speed_ms, Unary(op="cos", arg=angle)), mul(wind_speed_ms, Unary(op="sin", arg=angle))


def wind_drag_ratio_formula(headwind_ms: FormulaNode, crosswind_ms: FormulaNode, travel_speed_ms: FormulaNode) -> FormulaNode:
    """風の追加負荷（材料`wind_drag_ratio`、無次元）を、風を分解した成分（`wind_component_formulas`）から求める木。
    相対風速ベクトルの二乗則で、無風時に対する進行方向の空気抵抗の増分を`WIND_DRAG_REFERENCE_SPEED_MS`での無風時の
    抵抗を1とする倍率にしたもの。走行速度v・風速w・風向と走行方位の差dとして:

        x  = v + w·cos(d)              # 進行方向の相対風速（正=向かい風的）
        Vr = sqrt(x² + (w·sin(d))²)    # 相対風速の大きさ
        (Vr·x − v²) / v_ref²

    横風0のとき`sign(x)·x² − v²`の1次元式と一致し、追い風が走行速度を超える領域も連続。
    符号はxの符号で自然に決まる（正=向かい風で重くなる、負=追い風で楽になる、純横風は
    相対風速が増えるぶんだけ小さな正の値）。走行速度が大きいほど同じ風でも値が大きくなる。
    """
    along = add(travel_speed_ms, headwind_ms)
    relative_speed = Unary(op="sqrt", arg=add(mul(along, along), mul(crosswind_ms, crosswind_ms)))
    return div(sub(mul(relative_speed, along), mul(travel_speed_ms, travel_speed_ms)),
               const(WIND_DRAG_REFERENCE_SPEED_MS**2))


#: 道ごとの材料の名前: その道の風速（m/s）と風向（度、風が吹いてくる方向）。
WIND_SPEED_LEAF = "wind_speed_ms"
WIND_DIRECTION_LEAF = "wind_direction_deg"


def _wind_drag_ratio_way_formula() -> WayValueFormula:
    headwind, crosswind = wind_component_formulas(
        feature(WIND_SPEED_LEAF), feature(WIND_DIRECTION_LEAF), condition("bearing_deg"))
    travel_speed = div(condition("speed_kmh"), const(KMH_PER_MS))
    return WayValueFormula(
        value=Round(arg=wind_drag_ratio_formula(headwind, crosswind, travel_speed), decimals=WIND_DRAG_RATIO_DECIMALS),
        undetermined=FALSE,
    )


#: 地図へ配る風の材料の値（`WIND_DRAG_RATIO_DECIMALS`桁）。道ごとの風（`WIND_SPEED_LEAF`・`WIND_DIRECTION_LEAF`）と、
#: 要求の走行方位・想定速度から求める。走行方位で値の決まらない道は無い。
WIND_DRAG_RATIO_WAY_FORMULA = _wind_drag_ratio_way_formula()

_HEADWIND, _CROSSWIND = wind_component_formulas(feature("speed"), feature("direction"), feature("bearing"))
_WIND_DRAG_RATIO = wind_drag_ratio_formula(feature("headwind"), feature("crosswind"), feature("travel_speed"))


def wind_components(wind_speed_ms, wind_direction_deg, travel_bearing_deg) -> tuple[np.ndarray, np.ndarray]:
    """`wind_component_formulas`を値で評価する（m/s）。走行モデル（`domain/cycling_speed.py`）が空気抵抗を求めるのに
    使う。引数はスカラーまたはnumpyの規則で揃う配列。"""
    inputs = {"speed": wind_speed_ms, "direction": wind_direction_deg, "bearing": travel_bearing_deg}
    return evaluate_formula(_HEADWIND, inputs, {}), evaluate_formula(_CROSSWIND, inputs, {})


def wind_drag_ratio_array(wind_speed_ms, wind_direction_deg, travel_bearing_deg, travel_speed_ms: float) -> np.ndarray:
    """風の追加負荷（`wind_drag_ratio_formula`）。`wind_speed_ms`/`wind_direction_deg`/`travel_bearing_deg`はスカラー
    または同じ長さの配列、`travel_speed_ms`はリクエスト単位のスカラー（m/s、正）。"""
    return wind_drag_ratio_from_components(
        *wind_components(wind_speed_ms, wind_direction_deg, travel_bearing_deg), travel_speed_ms
    )


def wind_drag_ratio_from_components(headwind_ms, crosswind_ms, travel_speed_ms: float) -> np.ndarray:
    """`wind_drag_ratio_formula`を値で評価する。走行モデルと同じ成分を使い回せば、風向と方位の差の三角関数を1回で
    済ませられる。"""
    if travel_speed_ms <= 0:
        raise ValueError("wind_drag_ratio_array: travel_speed_ms must be positive")
    return evaluate_formula(
        _WIND_DRAG_RATIO, {"headwind": headwind_ms, "crosswind": crosswind_ms, "travel_speed": travel_speed_ms}, {})


def wind_drag_ratio(wind_speed_ms: float, wind_direction_deg: float, travel_bearing_deg: float, travel_speed_ms: float) -> float:
    """`wind_drag_ratio_array`のスカラー版（1地点・1方位向け）。"""
    return float(wind_drag_ratio_array(wind_speed_ms, wind_direction_deg, travel_bearing_deg, travel_speed_ms))


@dataclass(frozen=True)
class DepartureWind:
    """出発地点の出発時点の風（MSMの時系列の先頭）。時別の系列が無いとき、全区間へ一様に使う。"""

    speed_ms: float
    #: 風が吹いてくる方位（0=北・時計回り）。
    direction_deg: float


@dataclass(frozen=True)
class WindForecastSeries:
    """MSMの格子点ごとの時別風向・風速の予報系列（1時間刻み、`times`はタイムゾーン無しのローカル時刻[JST]）。探索前に
    各Edgeの通過予定時刻へ対応する風を引くために使う。`speed_ms`・`direction_deg`は（`lattice`の格子点, 時刻）で、
    格子点の値のまま（補間していない）。
    """

    times: list[datetime]
    speed_ms: np.ndarray
    direction_deg: np.ndarray
    lattice: MsmBlock

    def __post_init__(self) -> None:
        expected = (self.lattice.size, len(self.times))
        if len(self.times) < 2 or self.speed_ms.shape != expected or self.direction_deg.shape != expected:
            raise ValueError(
                f"WindForecastSeries: speed_ms/direction_deg must have the shape {expected} with >= 2 times"
            )
        step_hours = (self.times[1] - self.times[0]).total_seconds() / 3600
        if not math.isclose(step_hours, 1.0):
            raise ValueError(f"WindForecastSeries: expected hourly steps, got {step_hours}h")

    def _sample_index(self, start: datetime, passage_hours: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """`start`から`passage_hours`時間後に最も近い時刻の添字と、系列の範囲の外で端へ寄せたか。"""
        start_offset_hours = (start - self.times[0]).total_seconds() / 3600
        raw = np.rint(start_offset_hours + np.asarray(passage_hours, dtype=float)).astype(np.int64)
        index = np.clip(raw, 0, len(self.times) - 1)
        return index, index != raw

    def sample(
        self, start: datetime, passage_hours: np.ndarray, points: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray]:
        """`start`（タイムゾーン無しのローカル時刻）から`passage_hours`時間後に最も近い
        時刻の（風速, 風向）配列を、`points`（`passage_hours`と同じ並びの格子点の番号、`lattice.points_of`）
        ごとに返す。系列の範囲外は端の値へクランプする（探索では欠損より端の値の方が妥当）。"""
        index, _clamped = self._sample_index(start, passage_hours)
        return self.speed_ms[points, index], self.direction_deg[points, index]

    def sampled_times(self, start: datetime, passage_hours: np.ndarray) -> tuple[list[datetime], np.ndarray]:
        """`sample`が引く予報の時刻と、系列の範囲の外で端の時刻へ寄せたか（予報の先を延ばして使っている）。"""
        index, clamped = self._sample_index(start, passage_hours)
        return [self.times[i] for i in index], clamped

    def covers(self, at: datetime) -> bool:
        """`at`に最も近い時刻が系列の範囲の中にあるか（端の値で延ばさずに引けるか）。"""
        _, clamped = self._sample_index(at, np.zeros(1))
        return not bool(clamped[0])


def estimate_passage_hours(
    mid_lat: np.ndarray,
    mid_lon: np.ndarray,
    anchor: Coordinates,
    offset_hours: float,
    direction: int,
    speed_kmh: float,
    detour_ratio: float,
) -> np.ndarray:
    """各Edge（中点`mid_lat`/`mid_lon`）の通過予定時刻を、出発からの経過時間（h）として
    基準点`anchor`からの直線距離だけで推定する。`direction=+1`は基準点から離れていく
    レグ（`offset_hours + detour×距離/速度`）、`direction=-1`は基準点へ向かうレグ
    （`offset_hours − detour×距離/速度`、`offset_hours`は基準点への到着予定時刻）。
    経路の状態に依存しないため、探索前にbbox全体ぶんを1回のベクトル演算で求められる。"""
    if speed_kmh <= 0:
        raise ValueError("estimate_passage_hours: speed_kmh must be positive")
    distance_km = haversine_distance_km_array(mid_lat, mid_lon, anchor)
    return offset_hours + direction * cruise_hours(detour_ratio * distance_km, speed_kmh)


def cruise_hours(distance_km, speed_kmh: float):
    """`distance_km`を巡航速度で走ったとみなした所要時間（h）。走行モデルを通さない見込み（レグの時刻の置き方・
    探索の前の通過時刻の推定）はどれもこの模型で、レグごと・経路ごとに式を写さない。"""
    return distance_km / speed_kmh


def straight_line_hours(origin: Coordinates, destination: Coordinates, speed_kmh: float, detour_ratio: float) -> float:
    """起点から目的地までの見込み所要時間（h）。直線距離に迂回率を掛けた道なり距離を巡航速度で走るとみなす
    （`estimate_passage_hours`と同じ模型）。"""
    return cruise_hours(detour_ratio * haversine_distance_km(origin, destination), speed_kmh)


def reached_or_estimated_hours(reached_hours: np.ndarray, estimated_hours: np.ndarray) -> np.ndarray:
    """区間ごとの通過時刻: 前向きの探索が届いた区間は実際の到達時刻`reached_hours`、届かない（有限でない）
    区間だけ直線距離からの推定`estimated_hours`。"""
    return np.where(np.isfinite(reached_hours), reached_hours, estimated_hours)
