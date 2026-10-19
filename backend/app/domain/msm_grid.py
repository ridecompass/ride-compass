"""地図に描く、MSMの格子点の風と降水（`GET /api/weather/msm-grid`）。

値は格子点の値のままで、補間しない（domain/msm.py のモジュールの説明）。表示範囲の格子点が多いときは、格子の原点から数えて
同じ間隔おきの格子点だけを残す（`domain/msm.py: MsmBlock.thinned_points`）。
"""

from datetime import datetime
from typing import Annotated

import numpy as np
from pydantic import PlainSerializer

from app.domain.strict_model import StrictModel
from app.domain.time_zone import jst_local_text

#: 1回の応答に載せる格子点の数の上限。応答の大きさは格子点の数×予報の時間数に比例する。
MSM_GRID_MAX_POINTS = 600
#: 1回に読む矩形の広さの上限[平方度]。読む量は、間引く前の矩形の中の格子点の数に比例する。
MSM_GRID_MAX_AREA_SQ_DEG = 100.0
#: 地図がこのズーム未満の間は格子点を取らない。
MSM_GRID_MIN_ZOOM = 8

WIND_SPEED_MS_DECIMALS = 1
WIND_DIRECTION_DEG_DECIMALS = 0
PRECIPITATION_MM_DECIMALS = 1
# 格子点の位置は格子の原点と間隔の積で、浮動小数の端数が付く。0.1m未満を落とす。
_COORDINATE_DECIMALS = 6


def rounded_rows(values: np.ndarray, digits: int) -> list[list[float | None]]:
    """(点, 時刻)の配列を点ごとのリストへ丸める。格子の欠損（NaN）はNone。"""
    rounded = np.round(values, digits).astype(object)
    rounded[np.isnan(values)] = None
    return rounded.tolist()


def rounded_coordinates(values: np.ndarray) -> list[float]:
    return np.round(values, _COORDINATE_DECIMALS).tolist()


class MsmGridPointForecast(StrictModel):
    """格子点1つぶんの時別の風速・風向・降水量。配列の並びは応答の`times`と揃う。"""

    latitude: float
    longitude: float
    wind_speed_ms: list[float | None]
    #: 風が吹いてくる方位（北=0、東=90）。
    wind_direction_deg: list[float | None]
    #: その時刻までの1時間の降水量。
    precipitation_mm: list[float | None]


class MsmGridForecast(StrictModel):
    """表示範囲の中の、間引いた格子点ごとの予報。時刻は全部の格子点で共通なので1本だけ持つ。"""

    #: JSTのローカル時刻を分までのISO文字列（タイムゾーン指定なし）で出す。画面の時刻の読み方と揃える。
    times: list[Annotated[datetime, PlainSerializer(jst_local_text, return_type=str)]]
    #: 隣り合う格子点どうしの緯度・経度の間隔[度]。格子点はこの間隔の格子の上に並ぶ。
    latitude_step_deg: float
    longitude_step_deg: float
    points: list[MsmGridPointForecast]
