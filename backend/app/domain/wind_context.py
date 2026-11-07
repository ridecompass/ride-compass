"""区間ごとの風の成分を求める入力（探索の費用と地図のレンズが同じ値を読む）。"""

from dataclasses import dataclass
import numpy as np

from app.domain.wind import WindForecastSeries, wind_components


@dataclass(frozen=True)
class WindContext:
    """区間の向きと、引く風（時別の予報系列と、通過する時刻の予報の添字・各区間に最も近い格子点の番号）。

    予報の添字（`WindForecastSeries.time_index`）は、全区間が同じ時刻なら数、区間ごとの時刻なら`bearing_deg`と同じ行順の配列。
    """

    bearing_deg: np.ndarray
    wind_series: WindForecastSeries
    forecast_index: int | np.ndarray
    wind_points: np.ndarray

    def components(self) -> tuple[np.ndarray, np.ndarray]:
        """区間ごとの`(向かい風, 横風)`の成分（m/s、正が向かい風。`wind_components`）。"""
        speed, direction = self.wind_series.sample_at(self.forecast_index, self.wind_points)
        return wind_components(speed, direction, self.bearing_deg)
