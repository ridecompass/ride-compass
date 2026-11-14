import math
from dataclasses import dataclass
from datetime import datetime

import numpy as np
from numba import njit

from app.domain.geo import haversine_distance_km, haversine_distance_km_array
from app.domain.msm import MsmBlock
from app.domain.route import Coordinates
from app.domain.way_value_formula import (
    FormulaNode,
    Unary,
    const,
    evaluate_formula,
    feature,
    mul,
    sub,
)


# 道なり距離／直線距離の比の想定値。探索前に各Edgeの通過予定時刻を「基準点からの直線距離
# ×この比÷仮定速度」で推定するときに使う。風の時間解像度は1時間のため、この比のばらつきに
# よる推定誤差は同じビンへ収まる程度で足りる。
ROUTE_DETOUR_RATIO = 1.3

#: 時速（km/h）を秒速（m/s）へ直す割る数。
_KMH_PER_MS = 3.6


def kmh_to_ms(speed_kmh: float) -> float:
    return speed_kmh / _KMH_PER_MS


def detour_ratio_or_default(learned: float | None) -> float:
    """レグの時刻の推定に使う迂回率。探索範囲の学習値があればそれ、無ければ`ROUTE_DETOUR_RATIO`。"""
    return learned if learned is not None else ROUTE_DETOUR_RATIO


def is_usable_detour_ratio(measured: float) -> bool:
    """実測の迂回率を学習値・到着予定時刻に使ってよいか（NaN・非正は使わない）。"""
    return math.isfinite(measured) and measured > 0


def _wind_component_formulas(
    wind_speed_ms: FormulaNode, wind_direction_deg: FormulaNode, travel_bearing_deg: FormulaNode
) -> tuple[FormulaNode, FormulaNode]:
    """風を進行方向の成分（正が向かい風）と横成分へ分解する木（m/s）。"""
    # wind_direction_degは気象学の慣習で「風が吹いてくる方向」。走行方位との差が0で
    # 正面からの向かい風、180で背後からの追い風。
    angle = mul(sub(wind_direction_deg, travel_bearing_deg), const(math.pi / 180))
    return mul(wind_speed_ms, Unary(op="cos", arg=angle)), mul(wind_speed_ms, Unary(op="sin", arg=angle))


_HEADWIND, _CROSSWIND = _wind_component_formulas(feature("speed"), feature("direction"), feature("bearing"))


@njit(cache=True, nogil=True)
def drag_increases_m2_s2(headwind_ms: np.ndarray, crosswind_ms: np.ndarray, travel_speed_ms: float) -> np.ndarray:
    """風で増える空気抵抗の量（m²/s²。空気抵抗の係数を掛けると無風に対して増えた空気抵抗のN）を、区間ごとの風の成分の
    並びについて求める（float32）。走行速度v・進行方向の相対風速 x = v + 向かい風・相対風速の大きさ Vr = sqrt(x² + 横風²)
    として`Vr·x − v²`。横風0のとき`sign(x)·x² − v²`の1次元式と一致し、追い風が走行速度を超える領域も連続（正=向かい風で
    重くなる、負=追い風で楽になる、純横風は相対風速が増えるぶんだけ小さな正）。走行モデルが風の時刻ごとに探索の範囲の全区間で
    呼ぶ。"""
    increases = np.empty(len(headwind_ms), dtype=np.float32)
    for i in range(len(headwind_ms)):
        along = travel_speed_ms + headwind_ms[i]
        increases[i] = np.sqrt(along * along + crosswind_ms[i] * crosswind_ms[i]) * along - travel_speed_ms * travel_speed_ms
    return increases


def wind_components(wind_speed_ms, wind_direction_deg, travel_bearing_deg) -> tuple[np.ndarray, np.ndarray]:
    """`_wind_component_formulas`を値で評価する（m/s）。引数はスカラーまたはnumpyの規則で揃う配列。"""
    inputs = {"speed": wind_speed_ms, "direction": wind_direction_deg, "bearing": travel_bearing_deg}
    return evaluate_formula(_HEADWIND, inputs, {}), evaluate_formula(_CROSSWIND, inputs, {})



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
        """`start`から`passage_hours`時間後に最も近い時刻の添字と、系列の範囲の外で端へ寄せたか。
        ちょうど2つの時刻の中間は後の時刻へ倒す（`np.rint`の偶数丸めだと、中間が前後どちらへ倒れるかが時刻の偶奇で変わる）。"""
        start_offset_hours = (start - self.times[0]).total_seconds() / 3600
        raw = np.floor(start_offset_hours + np.asarray(passage_hours, dtype=float) + 0.5).astype(np.int64)
        index = np.clip(raw, 0, len(self.times) - 1)
        return index, index != raw

    def time_index(self, start: datetime, passage_hours: float | np.ndarray) -> int | np.ndarray:
        """`start`（タイムゾーン無しのローカル時刻）から`passage_hours`時間後に最も近い予報の時刻の添字（`passage_hours`が
        配列なら同じ並びの配列）。系列の範囲外は端の時刻へ寄せる（探索では欠損より端の値の方が妥当）。
        同じ添字の時刻は、どの格子点でも同じ風を引く。"""
        index, _clamped = self._sample_index(start, np.asarray(passage_hours))
        return index if index.ndim else int(index)

    def sample_at(self, index: int | np.ndarray, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """予報の時刻の添字`index`（`time_index`。数なら全格子点が同じ時刻、配列なら`points`と同じ並び）の（風速, 風向）
        配列を、`points`の格子点ごとに返す。"""
        return self.speed_ms[points, index], self.direction_deg[points, index]

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
