"""地図のレンズの道ごとの値の配信（ルートを出す前の地図の道と区間インスペクタ）。

取込範囲全体の道の網（`infrastructure/road_network_store.py: current`）から、タイルのフィーチャーの値を探索と同じ部品で求める
（`domain/lens_values.py`）。DBは読まない。値は風の時刻と想定速度で変わり、タイル1枚分の区間で走行の模型を解くだけなので
キャッシュしない。
"""

import asyncio
from collections.abc import Mapping
from datetime import datetime

import numpy as np

from app.domain.cost_axes import CostAxisDefinitions, burden_material_ids, current_cost_axes
from app.domain.dynamic_materials import DynamicAxisRequestContext
from app.domain.gradient import ROAD_BEARING_LEAF
from app.domain.ledger_costs import current_ledger_parameters
from app.domain.lens_values import LensTable, lens_table, tile_features
from app.domain.region import BoundingBox, tile_bounds_lonlat
from app.domain.road_network import MaterialFills, RoadNetwork, material_arrays_of, material_fills, slice_rows
from app.domain.time_zone import JST, as_series_time
from app.domain.tuning import tuning_value
from app.domain.wind import WindForecastSeries, kmh_to_ms
from app.infrastructure import road_network_store
from app.infrastructure.debug_log import log_external_call, log_throttled_warning
from app.services.graph_service import network_classes
from app.services.weather_service import WeatherService

_CATEGORY = "region:lens"

#: 道ごとの材料の名前（地図の式の木の葉）。道の向きに辿った値・逆向きに辿った値・道の向き。
LENS_ALONG_LEAF = "lens_along"
LENS_AGAINST_LEAF = "lens_against"

#: 最後に求めた欠けを埋める平均と、求めたときの道の網・区分の列・材料。どれかが替わったら求め直す。
_fills: tuple[RoadNetwork, object, tuple[str, ...], MaterialFills] | None = None


def _material_fills(network: RoadNetwork, classes: Mapping, material_ids: tuple[str, ...]) -> MaterialFills:
    """取込範囲全体の欠けを埋める平均。区分の材料の割合は全区間を数えるので、道の網・区分の列・材料の組ごとに1回だけ求める。"""
    global _fills
    cached = _fills
    if cached is not None and cached[0] is network and cached[1] is classes and cached[2] == material_ids:
        return cached[3]
    fills = material_fills(network, classes, material_ids)
    _fills = (network, classes, material_ids, fills)
    return fills


class LensService:
    def __init__(self, weather_service: WeatherService):
        self._weather_service = weather_service

    async def tile_table(self, z: int, x: int, y: int, at: datetime | None, speed_kmh: float) -> LensTable | None:
        """タイルのフィーチャーの、時刻`at`（省略すると今）の風と想定速度`speed_kmh`でのレンズの値。費用の軸の定義が無ければ
        None。風を読めない・時刻が予報の範囲の外なら無風で求める（探索と同じ）。"""
        axes = current_cost_axes()
        if axes is None:
            return None
        with log_external_call(_CATEGORY, z=z, x=x, y=y) as fields:
            network = road_network_store.current()
            features = await asyncio.to_thread(tile_features, network, z, x, y)
            fields["features"] = len(features)
            road = slice_rows(network, network_classes(network), features.rows)
            materials = material_arrays_of(road, {})
            wind = await self._wind(z, x, y, at, materials.mid_lat, materials.mid_lon, fields)
            classes = road.classes
            fills = _material_fills(network, classes, burden_material_ids(axes))
            return await asyncio.to_thread(
                _table, features, materials, network, axes, fills, speed_kmh, wind, materials.bearing_deg)

    async def _wind(self, z: int, x: int, y: int, at: datetime | None, mid_lat: np.ndarray, mid_lon: np.ndarray,
                    fields: dict) -> tuple[WindForecastSeries, datetime] | None:
        if not len(mid_lat):
            return None
        target = as_series_time(at or datetime.now(JST))
        bbox = tile_bounds_lonlat(z, x, y)
        # 道1本のフィーチャーの区間はタイルの外にありうるため、格子はタイルと区間の中点の両方を覆う。
        series = await self._weather_service.get_wind_forecast_lattice(BoundingBox(
            min_latitude=min(bbox.min_latitude, float(mid_lat.min())),
            min_longitude=min(bbox.min_longitude, float(mid_lon.min())),
            max_latitude=max(bbox.max_latitude, float(mid_lat.max())),
            max_longitude=max(bbox.max_longitude, float(mid_lon.max())),
        ))
        if series is None or not series.covers(target):
            fields["wind"] = "unavailable" if series is None else "out_of_range"
            log_throttled_warning(_CATEGORY, "レンズの風を読めないため無風で求める z=%d x=%d y=%d", z, x, y)
            return None
        return series, target


def _table(features, materials, network: RoadNetwork, axes: CostAxisDefinitions, fills: MaterialFills,
           speed_kmh: float, wind: tuple[WindForecastSeries, datetime] | None, bearing_deg: np.ndarray) -> LensTable:
    rows = features.rows
    if wind is None:
        components = (np.zeros(len(rows)), np.zeros(len(rows)))
    else:
        series, target = wind
        context = DynamicAxisRequestContext(
            bearing_deg=bearing_deg, departure_wind=None, travel_speed_ms=kmh_to_ms(speed_kmh), wind_series=series,
            forecast_index=series.time_index(target, 0.0),
            wind_points=series.lattice.points_of(materials.mid_lat, materials.mid_lon))
        components = context.wind_components_ms or (np.zeros(len(rows)), np.zeros(len(rows)))
    # つまみは探索と同じ割増の強さの較正値、倍率はどの軸も標準の1（`services/road_graph_engine.py`と同じ値）。
    parameters = current_ledger_parameters(tuning_value("evaluation.penalty_strength"), {})
    return lens_table(features, materials.columns, materials.distance_m, materials.elevation_profiles,
                      (network.steepest_gain_percent[rows], network.steepest_loss_percent[rows]),
                      axes, parameters, speed_kmh, fills, components)


def lens_way_materials(table: LensTable, lens_id: str) -> dict[str, dict[str, float]] | None:
    """レンズ`lens_id`の、フィーチャーごとの道ごとの材料（値の無い材料は載せない）。知らないレンズならNone。"""
    values = table.values.get(lens_id)
    if values is None:
        return None
    features = table.features
    result: dict[str, dict[str, float]] = {}
    for key, (along, against), bearing in zip(features.keys, values, features.bearing_deg):
        leaves = {name: float(value) for name, value in ((LENS_ALONG_LEAF, along), (LENS_AGAINST_LEAF, against),
                                                         (ROAD_BEARING_LEAF, bearing)) if not np.isnan(value)}
        if LENS_ALONG_LEAF in leaves or LENS_AGAINST_LEAF in leaves:
            result[key] = leaves
    return result
