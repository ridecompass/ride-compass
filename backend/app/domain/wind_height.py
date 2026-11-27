"""予報の地上10mの風を、乗り手の高さの風へ直す倍率（WMO-No.8 の式5.3 の2段の対数則）。

    倍率 = ln(60/z0g) / ln(10/z0g) × ln(h/z0r) / ln(60/z0r)

格子の側の粗度長 z0g（10mの風が吹く上流）で10mから混ざる高さ60mへ上げ、道の側の粗度長 z0r で60mから乗り手の高さ h へ
下ろす。z0r は区間の周りの帯の土地被覆の割合で ln(z0) を平均したもの（被覆が混じるときの WMO の附属書の勧め）、z0g は
中点に一番近い MSM の格子点が同じ区間どうしで、z0r の ln を長さで平均したもの。倍率は風速に掛ける（向かい風と横風の両方に
同じ倍率が効く）。倍率は区間の被覆・長さ・中点と格子だけで決まり、風の時刻には季節でだけ依る。
"""

import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass

import numpy as np

from app.domain.landcover import LANDCOVER_CLASSES
from app.domain.msm import MsmBlock, MsmGrid
from app.domain.tuning import RIDER_HEIGHT_ID, ROUGHNESS_CAP_ID, Tuning

#: 予報の風の高さ（m）。MSM の地上10mの風。
FORECAST_HEIGHT_M = 10.0
#: 上流の風と道の側の風が混ざる高さ（m）。WMO-No.8（Guide to Instruments and Methods of Observation）の式5.3。
BLENDING_HEIGHT_M = 60.0
#: 道路網のどの区間にも土地被覆が無いときの粗度長（m）。WMO-No.8 が地上10mの風を測る標準とする、開けた平地の値。
OPEN_TERRAIN_ROUGHNESS_M = 0.03

#: 土地被覆のクラス（割合の列の名前）→（夏, 冬）の粗度長（m）。WRF `run/LANDUSE.TBL` の MODIFIED_IGBP_MODIS_NOAH の
#: SFZ0（cm。`phys/module_physics_init.F` が100で割って m にする）の、対応する MODIS の分類の値。
ROUGHNESS_LENGTH_M: Mapping[str, tuple[float, float]] = {
    "water_percent": (0.0001, 0.0001),  # 17 Water
    # 1〜4 の森（Evergreen・Deciduous の Needleleaf・Broadleaf。どれも夏冬 50cm）。土地被覆の樹木は混交の割合を持たないので、
    # 冬に 20cm になる 5 Mixed Forests には当てない。
    "trees_percent": (0.50, 0.50),
    "flooded_veg_percent": (0.30, 0.30),  # 11 Permanent wetlands
    "crops_percent": (0.15, 0.05),  # 12 Croplands
    "built_percent": (0.80, 0.80),  # 13 Urban and Built-Up
    "bare_percent": (0.01, 0.01),  # 16 Barren or Sparsely Vegetated
    "snow_ice_percent": (0.001, 0.001),  # 15 Snow and Ice
    "rangeland_percent": (0.12, 0.10),  # 10 Grasslands
}
if set(ROUGHNESS_LENGTH_M) != {cls.percent_field for cls in LANDCOVER_CLASSES}:
    raise ValueError("粗度長の表が、土地被覆のクラスと1対1でない")

#: 夏とみなす通日（1月1日が1）の範囲。WRF と同じく、105より前か288より後は冬（`phys/module_physics_init.F` の
#: `JULDAY.LT.105.OR.JULDAY.GT.288`）。
_SUMMER_DAYS = (105, 288)


def height_factors(percent: Mapping[str, np.ndarray], distance_m: np.ndarray, mid_lat: np.ndarray, mid_lon: np.ndarray,
                   grid: MsmGrid, tuning: Tuning) -> np.ndarray:
    """区間ごとの、予報の10mの風を乗り手の高さの風へ直す倍率（`(区間, 2)`の float32。列は夏・冬）。`percent`は土地被覆の
    割合の列の名前（`ROUGHNESS_LENGTH_M`の鍵の全部）→ 区間ごとの割合（%。欠けは埋めて渡す）、`distance_m`・`mid_lat`・`mid_lon`は
    区間の長さと中点。格子の側の粗度は、中点に一番近い MSM の格子`grid`の格子点（格子の外の中点は端の格子点）が同じ区間の組で
    求める。割合の無い区間（渡した全区間に土地被覆が無い）は、開けた平地の粗度長の道とする。"""
    cap, rider = tuning.value(ROUGHNESS_CAP_ID), math.log(tuning.value(RIDER_HEIGHT_ID))
    distance = np.asarray(distance_m, dtype=np.float64)
    nearest = MsmBlock(grid=grid, row0=0, col0=0, rows=grid.n_lat, cols=grid.n_lon).points_of(mid_lat, mid_lon)
    _, points = np.unique(nearest, return_inverse=True)
    lengths = np.bincount(points, weights=distance)
    blending = math.log(BLENDING_HEIGHT_M)
    factors = np.empty((len(distance), 2), dtype=np.float32)
    for season in (0, 1):
        weighted = sum(np.asarray(percent[field], dtype=np.float64) * math.log(min(roughness[season], cap))
                       for field, roughness in ROUGHNESS_LENGTH_M.items())
        total = sum(np.asarray(percent[field], dtype=np.float64) for field in ROUGHNESS_LENGTH_M)
        road = np.divide(weighted, total, out=np.full(len(distance), math.log(OPEN_TERRAIN_ROUGHNESS_M)),
                         where=total > 0)  # NaNの割合は偽
        mean = np.divide(np.bincount(points, weights=distance * road), lengths, out=np.zeros_like(lengths), where=lengths > 0)
        grid_side = np.where(lengths[points] > 0, mean[points], road)  # 長さ0の区間だけの格子点は、その区間の粗度
        factors[:, season] = ((blending - grid_side) / (math.log(FORECAST_HEIGHT_M) - grid_side)
                              * (rider - road) / (blending - road))
    return factors


def seasonal_factors(factors: np.ndarray, day_of_year: int | np.ndarray) -> np.ndarray:
    """`height_factors`の倍率のうち、通る日（通日。全区間が同じ日なら数、区間ごとなら`factors`の行と同じ並びの配列）の季節の
    列（区間ごと）。"""
    day = np.asarray(day_of_year)
    summer = (day >= _SUMMER_DAYS[0]) & (day <= _SUMMER_DAYS[1])
    if summer.ndim == 0:
        return factors[:, 0 if summer else 1]
    return np.where(summer, factors[:, 0], factors[:, 1])


@dataclass(frozen=True)
class WindHeights:
    """区間の行の倍率（`height_factors`）の引き口。倍率は格子で決まり、格子は風の予報を読むまで決まらないので、格子を渡されたときに
    引く。`factors_of`は格子 → 全区間の倍率、`rows`はそのうちのこの区間の行、`filled_of`は全区間の、土地被覆の割合が欠けて
    埋めた値で倍率を求めるか（bool）。"""

    factors_of: Callable[[MsmGrid], np.ndarray]
    rows: np.ndarray
    filled_of: Callable[[], np.ndarray]

    def of_grid(self, grid: MsmGrid) -> np.ndarray:
        """格子`grid`での、`rows`の並びの倍率。"""
        return self.factors_of(grid)[self.rows]

    def filled(self) -> np.ndarray:
        """`rows`の並びの、土地被覆の割合が欠けて埋めた値で倍率を求める区間（bool）。"""
        return self.filled_of()[self.rows]
