"""`domain/wind_height.py`——予報の地上10mの風を、区間の周りと格子点の周りの土地被覆の粗度長で乗り手の高さ（1m）の風へ直す倍率
（`height_factors`）と、通る日の季節の倍率（`seasonal_factors`）。土地被覆の欠けた道は、道路網の倍率
（`domain/road_network.py: RoadNetwork.wind_height_factors`）で見る。

期待値は換算の約束（WMO-No.8 の式5.3 の2段の対数則・WRF の粗度長の表・市街の0.5mの頭打ち）から取る。

ここで見ないもの:
- 探索と地図のレンズが同じ区間で同じ倍率を引き、ルートの事実と道の窓が乗り手の高さの風を出すこと → `test_region_lens.py`
- 欠けた材料を道路網全体の平均で埋めること → `test_road_network.py`
"""

import math

import numpy as np
import pytest

from app.domain.landcover import LANDCOVER_CLASSES
from app.domain.msm import MsmGrid
from app.domain.wind_height import height_factors, seasonal_factors
from tests.road_network_fixture import road_network

#: 0.1度刻みの格子（区間の中点はどれも、置いた格子点のすぐ近く）。
GRID = MsmGrid(lat_min=35.0, lon_min=139.0, d_lat=0.1, d_lon=0.1, n_lat=10, n_lon=10)
SUMMER, WINTER = 0, 1
#: WRF の夏・冬の粗度長（m）。
WATER, TREES, BARE, CROPS_SUMMER, CROPS_WINTER = 0.0001, 0.5, 0.01, 0.15, 0.05


def _log_law(z0_grid: float, z0_road: float) -> float:
    """WMO-No.8 の式5.3 の2段: 格子の側の粗度長で10mから60mへ上げ、道の側の粗度長で60mから1mへ下ろす。"""
    return math.log(60 / z0_grid) / math.log(10 / z0_grid) * math.log(1 / z0_road) / math.log(60 / z0_road)


def _cover(*shares: dict[str, float]) -> dict[str, np.ndarray]:
    """区間ごとの被覆（割合の列の名前の鍵 → %。書かないクラスは0%）。"""
    return {cls.percent_field: np.array([share.get(cls.percent_field, 0.0) for share in shares]) for cls in LANDCOVER_CLASSES}


def _factors(percent, *, points, distance=None) -> np.ndarray:
    """区間ごとの倍率。`points`は区間の中点を置く格子点の（行, 列）。"""
    lat = np.array([GRID.lat_min + row * GRID.d_lat for row, _ in points])
    lon = np.array([GRID.lon_min + col * GRID.d_lon for _, col in points])
    return height_factors(percent, np.ones(len(points)) if distance is None else np.asarray(distance, dtype=float),
                          lat + 0.01, lon - 0.01, GRID)


@pytest.mark.parametrize(("cover", "season", "expected"), [
    ("water_percent", SUMMER, 0.80),
    ("crops_percent", SUMMER, 0.45),
    ("crops_percent", WINTER, _log_law(CROPS_WINTER, CROPS_WINTER)),
    ("trees_percent", SUMMER, 0.23),
    # 市街は WRF の 0.80m を 0.5m で頭打ちにし、森と同じ倍率になる。
    ("built_percent", SUMMER, 0.23),
], ids=["水面", "作物の夏", "作物の冬", "森", "市街の頭打ち"])
def test_a_road_inside_one_cover_lowers_the_wind_by_the_log_law_of_its_roughness(cover, season, expected):
    """道も格子点の周りも同じ被覆なら、その粗度長の対数則の倍率（設計の値）で10mの風を1mへ下ろす。粗いほど弱い。"""
    factors = _factors(_cover({cover: 100.0}), points=[(1, 1)])

    assert factors[0, season] == pytest.approx(expected, abs=0.005)


def test_the_grid_side_roughness_is_the_length_mean_of_the_roads_near_the_same_grid_point():
    """格子の側の粗度は、中点に一番近い格子点が同じ区間の ln(z0) の長さの平均。市街の格子点の中の河川敷の道は、開けた格子点の
    同じ河川敷の道より上流の風が強く（10m の風が粗い面の上の値なので）、1つの区間の被覆も割合で ln(z0) を平均する。"""
    percent = _cover({"bare_percent": 100.0}, {"built_percent": 100.0}, {"bare_percent": 100.0},
                     {"water_percent": 50.0, "trees_percent": 50.0})
    factors = _factors(percent, points=[(1, 1), (1, 1), (5, 5), (8, 8)], distance=[1.0, 3.0, 1.0, 1.0])

    urban_grid = math.exp((math.log(BARE) + 3 * math.log(TREES)) / 4)
    mixed = math.exp((math.log(WATER) + math.log(TREES)) / 2)
    assert factors[:, SUMMER] == pytest.approx(
        [_log_law(urban_grid, BARE), _log_law(urban_grid, TREES), _log_law(BARE, BARE), _log_law(mixed, mixed)], abs=1e-5)


@pytest.mark.parametrize(("covers", "overall_of"), [
    # 土地被覆の無い道（2本目）は、ほかの数値の材料と同じく割合を道路網全体の平均で埋めた道として走る（被覆の割合の和が100なので、
    # 被覆のある道の ln(z0) の長さの平均と同じ）。格子点にほかの道が無いので、格子の側も同じ。
    ({1: {"water_percent": 100.0}, 2: None, 3: {"trees_percent": 100.0}},
     lambda km: math.exp((km[1] * math.log(WATER) + km[3] * math.log(TREES)) / (km[1] + km[3]))),
    # どの道にも土地被覆が無い道路網は、開けた平地（0.03m）の道として走る。
    ({1: None, 2: None, 3: None}, lambda km: 0.03),
], ids=["一部の道に土地被覆が無い", "どの道にも土地被覆が無い"])
def test_a_road_without_landcover_runs_in_the_mean_roughness_of_the_network(covers, overall_of):
    """道路網の倍率（`RoadNetwork.wind_height_factors`）。道は別々の格子点の近くに置き、3本目は1本目の3倍の長さ。"""
    coordinates = {}
    for way, length in ((1, 0.01), (2, 0.01), (3, 0.03)):
        coordinates[way * 10] = (35.15 + 0.3 * way, 139.15)
        coordinates[way * 10 + 1] = (35.15 + 0.3 * way + length, 139.15)
    network = road_network(coordinates, {(way, 0): (way * 10, way * 10 + 1) for way in covers}, numeric={
        cls.percent_field: (lambda field: lambda rows: [
            np.nan if covers[int(way)] is None else covers[int(way)].get(field, 0.0) for way in rows.way])(cls.percent_field)
        for cls in LANDCOVER_CLASSES})
    km = {int(way): float(length) for way, length in zip(network.edge_way_id, network.distance_m, strict=True)}

    factors = network.wind_height_factors(GRID)

    overall = overall_of(km)
    (row, *_) = np.flatnonzero(network.edge_way_id == 2)
    assert factors[row, SUMMER] == pytest.approx(_log_law(overall, overall), abs=0.005)


@pytest.mark.parametrize(("day", "column"), [(104, WINTER), (105, SUMMER), (288, SUMMER), (289, WINTER)],
                         ids=["4月14日", "4月15日", "10月15日", "10月16日"])
def test_the_season_of_the_passing_day_picks_the_summer_or_winter_roughness(day, column):
    """通日が105より前か288より後の日は冬の粗度長で解く（WRF と同じ季節の決め方。2026年の通日）。"""
    factors = _factors(_cover({"crops_percent": 100.0}), points=[(1, 1)])

    assert seasonal_factors(factors, day) == pytest.approx([factors[0, column]])
    assert seasonal_factors(factors, np.array([day])) == pytest.approx([factors[0, column]])
