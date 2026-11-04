"""区間ごとの風の成分を求める入力（探索の費用と地図のレンズが同じ値を読む）。"""

from dataclasses import dataclass
from functools import cached_property

import numpy as np

from app.domain.wind import DepartureWind, WindForecastSeries, wind_components


@dataclass(frozen=True)
class WindContext:
    """区間の向きと、引く風（時別の予報系列か出発時点の値）。

    時別系列と通過する時刻の予報の添字（`WindForecastSeries.time_index`。全区間が同じ時刻なら数、区間ごとの時刻なら
    `bearing_deg`と同じ行順の配列）と、各区間に最も近い格子点の番号（同じ行順）の3つが揃っていれば区間ごとにその時刻の
    風を引き、揃っていなければ`departure_wind`（出発時点のスナップショット）を全区間へ一様に使う。
    """

    bearing_deg: np.ndarray
    departure_wind: DepartureWind | None
    wind_series: WindForecastSeries | None
    forecast_index: int | np.ndarray | None
    wind_points: np.ndarray | None

    @cached_property
    def _components(self) -> tuple[np.ndarray, np.ndarray] | None:
        if self.wind_series is not None and self.wind_points is not None and self.forecast_index is not None:
            speed, direction = self.wind_series.sample_at(self.forecast_index, self.wind_points)
        elif self.departure_wind is not None:
            speed = np.asarray(self.departure_wind.speed_ms, dtype=float)
            direction = np.asarray(self.departure_wind.direction_deg, dtype=float)
        else:
            return None
        return wind_components(speed, direction, self.bearing_deg)

    def components_or_calm(self) -> tuple[np.ndarray, np.ndarray]:
        """区間ごとの`(向かい風, 横風)`の成分（m/s、正が向かい風。`wind_components`）。風が無ければ0（無風）。"""
        components = self._components
        if components is None:
            zeros = np.zeros(len(self.bearing_deg))
            return zeros, zeros
        return components
