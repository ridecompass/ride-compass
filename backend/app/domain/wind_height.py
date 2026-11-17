"""予報の地上10mの風を、乗り手の高さの風へ直す倍率（WMO-No.8 の式5.3 の2段の対数則）。

    倍率 = ln(60/z0g) / ln(10/z0g) × ln(h/z0r) / ln(60/z0r)

格子の側の粗度長 z0g（10mの風が吹く上流）で10mから混ざる高さ60mへ上げ、道の側の粗度長 z0r で60mから乗り手の高さ h へ
下ろす。z0r は区間の周りの帯の土地被覆の割合で ln(z0) を平均したもの（被覆が混じるときの WMO の附属書の勧め）、z0g は
中点に一番近い MSM の格子点が同じ区間どうしで、z0r の ln を長さで平均したもの。どちらも、土地被覆の無い区間・区間の無い
格子点は道路網全体の区間の ln(z0) の長さの平均にする。倍率は風速に掛ける（向かい風と横風の両方に同じ倍率が効く）。

倍率は区間と格子だけで決まり、風の時刻に依らない（季節だけで変わる）ので、道路網ごとに全区間について1回求め、探索と地図の
レンズは同じ区間の同じ値を引く。
"""

import math
from collections.abc import Mapping

import numpy as np

from app.domain.landcover import LANDCOVER_CLASSES
from app.domain.msm import MsmGrid

#: 予報の風の高さ（m）。MSM の地上10mの風。
FORECAST_HEIGHT_M = 10.0
#: 上流の風と道の側の風が混ざる高さ（m）。WMO-No.8（Guide to Instruments and Methods of Observation）の式5.3。
BLENDING_HEIGHT_M = 60.0
#: 乗り手の高さ（m）。定義で、出典は無い。踏み増しの向かい風の効きの元の実測（Pérez Castro ら 2026）の風が、自転車に付けた
#: 風速計の値なので、その高さに揃える。
RIDER_HEIGHT_M = 1.0
#: 粗度長の頭打ち（m）。標準の模型ではない仮の定義で、WMO-No.8 が式5.3 で補正してよいとする粗度長の上限。市街（WRF の
#: 0.80m）だけが越える。格子の側・道の側の両方に掛ける。
ROUGHNESS_CAP_M = 0.5
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


def _road_log_roughness(percent: Mapping[str, np.ndarray], winter: bool) -> np.ndarray:
    """区間ごとの道の側の粗度長の対数 ln(z0r)（被覆の割合で ln(z0) を平均したもの。土地被覆の無い区間はNaN）。"""
    weighted: np.ndarray | float = 0.0
    total: np.ndarray | float = 0.0
    for field, lengths in ROUGHNESS_LENGTH_M.items():
        share = np.asarray(percent[field], dtype=np.float64) if field in percent else np.nan
        weighted = weighted + share * math.log(min(lengths[winter], ROUGHNESS_CAP_M))
        total = total + share
    total = np.asarray(total, dtype=np.float64)
    return np.divide(weighted, total, out=np.full(total.shape, np.nan), where=total > 0)  # NaNの割合は偽


def height_factors(percent: Mapping[str, np.ndarray], distance_m: np.ndarray, mid_lat: np.ndarray, mid_lon: np.ndarray,
                   grid: MsmGrid) -> np.ndarray:
    """区間ごとの、予報の10mの風を乗り手の高さの風へ直す倍率（`(区間, 2)`の float32。列は夏・冬）。`percent`は割合の列の名前 →
    区間ごとの割合（%）で、無い列は値の無い列とみなす。`distance_m`・`mid_lat`・`mid_lon`は区間の長さと中点。どの区間も、MSM の
    格子`grid`の中点に一番近い格子点（格子の外の中点は端の格子点）の組で、格子の側の粗度長を求める。"""
    distance = np.asarray(distance_m, dtype=np.float64)
    rows = np.clip(np.rint((np.asarray(mid_lat, dtype=np.float64) - grid.lat_min) / grid.d_lat), 0, grid.n_lat - 1)
    cols = np.clip(np.rint((np.asarray(mid_lon, dtype=np.float64) - grid.lon_min) / grid.d_lon), 0, grid.n_lon - 1)
    _, points = np.unique(rows.astype(np.int64) * grid.n_lon + cols.astype(np.int64), return_inverse=True)
    blending = math.log(BLENDING_HEIGHT_M)
    factors = np.empty((len(distance), 2), dtype=np.float32)
    for season in (0, 1):
        road = _road_log_roughness(percent, winter=bool(season))
        known = ~np.isnan(road)
        weight = np.where(known, distance, 0.0)
        weighted = weight * np.where(known, road, 0.0)
        overall = float(weighted.sum() / weight.sum()) if weight.sum() > 0 else math.log(OPEN_TERRAIN_ROUGHNESS_M)
        lengths = np.bincount(points, weights=weight)
        grid_side = np.divide(np.bincount(points, weights=weighted), lengths, out=np.full(len(lengths), overall),
                              where=lengths > 0)[points]
        road = np.where(known, road, overall)
        factors[:, season] = ((blending - grid_side) / (math.log(FORECAST_HEIGHT_M) - grid_side)
                              * (math.log(RIDER_HEIGHT_M) - road) / (blending - road))
    return factors


def seasonal_factors(factors: np.ndarray, day_of_year: int | np.ndarray) -> np.ndarray:
    """`height_factors`の倍率のうち、通る日（通日。全区間が同じ日なら数、区間ごとなら`factors`の行と同じ並びの配列）の季節の
    列（区間ごと）。"""
    day = np.asarray(day_of_year)
    summer = (day >= _SUMMER_DAYS[0]) & (day <= _SUMMER_DAYS[1])
    return np.where(summer, factors[:, 0], factors[:, 1])
