"""区間ごとの風の成分と気温を求める入力（探索の費用と地図のレンズが同じ値を読む）。"""

from dataclasses import dataclass
from typing import Protocol

import numpy as np

from app.domain.wind import WindForecastSeries, wind_components
from app.domain.wind_height import WindHeights, seasonal_factors


class WindRoads(Protocol):
    """風を引く区間の並び（区間の向き・中点・風の高さの倍率の引き口）。"""

    @property
    def bearing_deg(self) -> np.ndarray: ...
    @property
    def mid_lat(self) -> np.ndarray: ...
    @property
    def mid_lon(self) -> np.ndarray: ...
    @property
    def wind_heights(self) -> WindHeights: ...


@dataclass(frozen=True)
class WindContext:
    """区間ごとに予報の系列から風と気温を引く入力のうち、時刻に依らないもの: 区間の向き・最も近い格子点の番号と、予報の10mの
    風を乗り手の高さへ直す倍率（行×(夏, 冬)）。"""

    wind_series: WindForecastSeries
    bearing_deg: np.ndarray
    wind_points: np.ndarray
    height_factors: np.ndarray

    @classmethod
    def of(cls, wind_series: WindForecastSeries, roads: WindRoads) -> "WindContext":
        """区間の並び`roads`の、系列`wind_series`から引く入力（中点に最も近い格子点。並びの外の中点は端の格子点）。"""
        lattice = wind_series.lattice
        return cls(wind_series, roads.bearing_deg, lattice.points_of(roads.mid_lat, roads.mid_lon),
                   roads.wind_heights.of_grid(lattice.grid))

    def take(self, rows: np.ndarray) -> "WindContext":
        """行`rows`だけの入力。"""
        return WindContext(self.wind_series, self.bearing_deg[rows], self.wind_points[rows], self.height_factors[rows])

    def components(self, forecast_index: int | np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """予報の時刻の添字`forecast_index`（`WindForecastSeries.time_index`。全区間が同じ時刻なら数、区間ごとの時刻なら行の並びの
        配列）での、区間ごとの乗り手の高さの`(向かい風, 横風)`の成分（m/s、正が向かい風。`wind_components`）と気温（℃）。倍率は
        通る時刻の日付の季節のもの。"""
        speed, direction, temperature = self.wind_series.sample_at(forecast_index, self.wind_points)
        factor = seasonal_factors(self.height_factors, self.wind_series.day_of_year[forecast_index])
        return (*wind_components(speed * factor, direction, self.bearing_deg), temperature)
