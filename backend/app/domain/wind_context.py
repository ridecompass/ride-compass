"""区間ごとの風の成分と気温を求める入力（探索の費用と地図のレンズが同じ値を読む）。"""

from dataclasses import dataclass
import numpy as np

from app.domain.wind import WindForecastSeries, wind_components
from app.domain.wind_height import seasonal_factors


@dataclass(frozen=True)
class WindContext:
    """区間の向きと、引く風と気温（時別の予報系列と、通過する時刻の予報の添字・各区間に最も近い格子点の番号）と、予報の10mの
    風を乗り手の高さへ直す倍率（`domain/wind_height.py: height_factors`の区間の行）。

    予報の添字（`WindForecastSeries.time_index`）は、全区間が同じ時刻なら数、区間ごとの時刻なら`bearing_deg`と同じ行順の配列。
    """

    bearing_deg: np.ndarray
    wind_series: WindForecastSeries
    forecast_index: int | np.ndarray
    wind_points: np.ndarray
    height_factors: np.ndarray

    def components(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """区間ごとの乗り手の高さの`(向かい風, 横風)`の成分（m/s、正が向かい風。`wind_components`）と気温（℃）。倍率は通る
        時刻の日付の季節のもの。"""
        speed, direction, temperature = self.wind_series.sample_at(self.forecast_index, self.wind_points)
        factor = seasonal_factors(self.height_factors, self.wind_series.day_of_year[self.forecast_index])
        return (*wind_components(speed * factor, direction, self.bearing_deg), temperature)
