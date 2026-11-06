"""地図のレンズの道ごとの値の配信（ルートを出す前の地図の道と道の窓）。

取込範囲全体の道の網（`infrastructure/road_network_store.py: current`）から、タイルのフィーチャーの値を探索と同じ部品で求める
（`domain/lens_values.py`）。DBは読まない。値は風の時刻と想定速度で変わり、タイル1枚分の区間で走行の模型を解くだけなので
キャッシュしない。
"""

import asyncio
from dataclasses import dataclass
from datetime import datetime

import numpy as np

from app.domain.cost_axes import CostAxisDefinitions, burden_material_ids, cost_axis_ids, current_cost_axes
from app.domain.lens_total import TOTAL_LENS_ID
from app.domain.cost_preference import CostPreference
from app.domain.wind_context import WindContext
from app.domain.gradient import ROAD_BEARING_LEAF
from app.domain.ledger_costs import current_ledger_parameters
from app.domain.lens_values import (
    LensFactInputs,
    LENS_AGAINST_LEAF,
    LENS_ALONG_LEAF,
    LensFeatures,
    LensInspection,
    LensTable,
    lens_inspection,
    lens_table,
    painted_direction,
    tile_features,
)
from app.domain.region import BoundingBox, tile_bounds_lonlat
from app.domain.attributes import EdgeMaterialColumns
from app.domain.road_classes import class_labels, current_road_classes
from app.domain.road_network import MaterialFills, RoadNetwork, material_arrays_of, slice_rows
from app.domain.time_zone import JST, as_series_time
from app.domain.wind import WindForecastSeries
from app.infrastructure import road_network_store
from app.infrastructure.debug_log import log_external_call, log_throttled_warning
from app.services.graph_service import network_classes, network_fills
from app.services.weather_service import WeatherService

_CATEGORY = "region:lens"

@dataclass(frozen=True)
class _TileLens:
    """タイル1枚のレンズの値と、道の窓が引く事実の入力。"""

    table: LensTable
    facts: LensFactInputs


class LensService:
    def __init__(self, weather_service: WeatherService):
        self._weather_service = weather_service

    async def tile_table(self, z: int, x: int, y: int, at: datetime | None, speed_kmh: float,
                         preference: CostPreference) -> LensTable:
        """タイルのフィーチャーの、時刻`at`（省略すると今）の風と想定速度`speed_kmh`と利用者の値`preference`（つまみと倍率。
        ルート生成と同じ値で塗る）でのレンズの値。風を読めない・時刻が予報の範囲の外なら無風で求める（探索と同じ）。"""
        tile = await self._tile(z, x, y, at, speed_kmh, preference)
        assert tile is not None  # フィーチャーを絞らなければ、空のタイルも空の表で返る
        return tile.table

    async def way_materials(self, lens_id: str, z: int, x: int, y: int, at: datetime | None,
                            speed_kmh: float, preference: CostPreference) -> dict[str, dict[str, float]] | None:
        """レンズ`lens_id`の、タイルのフィーチャーごとの道ごとの材料（道の向き・逆向きに辿った値と道の向き。値の無い材料は
        載せない）。知らないレンズか、利用者が無効にした軸のレンズならNone。"""
        counts = current_ledger_parameters(preference).counts
        if lens_id not in {TOTAL_LENS_ID, *filter(counts, cost_axis_ids(current_cost_axes()))}:
            return None
        return _way_materials(await self.tile_table(z, x, y, at, speed_kmh, preference), lens_id)

    async def inspect(self, feature_key: str, z: int, x: int, y: int, bearing_deg: float, at: datetime | None,
                      speed_kmh: float, preference: CostPreference) -> LensInspection | None:
        """押したフィーチャー（地図がタイル`z/x/y`で塗っている単位）の、地図と同じ値と、その元の事実。タイルにその
        フィーチャーが無ければNone。"""
        tile = await self._tile(z, x, y, at, speed_kmh, preference, only=feature_key)
        if tile is None:
            return None
        road_classes = current_road_classes()
        labels = class_labels(road_classes.classifications.get(road_classes.rolling_resistance_classification or ""))
        painted = painted_direction(bearing_deg, float(tile.table.features.bearing_deg[0]))
        return lens_inspection(tile.table, 0, painted, tile.facts, labels)

    async def _tile(self, z: int, x: int, y: int, at: datetime | None, speed_kmh: float, preference: CostPreference,
                    only: str | None = None) -> _TileLens | None:
        """タイルのレンズの値。`only`を渡すとそのフィーチャーだけで求める（無ければNone）。"""
        axes = current_cost_axes()
        with log_external_call(_CATEGORY, z=z, x=x, y=y) as fields:
            prepared = await asyncio.to_thread(_prepare, road_network_store.current(), z, x, y, axes, only)
            if prepared is None:
                return None
            features, materials, fills, steepest = prepared
            fields["features"] = len(features)
            wind = await self._wind(z, x, y, at, materials.mid_lat, materials.mid_lon, fields)
            return await asyncio.to_thread(_tile_lens, features, materials, axes, fills, speed_kmh, preference, wind,
                                           steepest)

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


def _prepare(network: RoadNetwork, z: int, x: int, y: int, axes: CostAxisDefinitions, only: str | None
             ) -> tuple[LensFeatures, EdgeMaterialColumns, MaterialFills, tuple[np.ndarray, np.ndarray]] | None:
    """風に依らない入力（フィーチャーと行・材料・欠けを埋める平均・一番急な登りと下り）。道路網の全区間を走査し、初回は
    取込範囲全体の区分の列と平均も求めるので、イベントループの外で呼ぶ。"""
    tile = tile_features(network, z, x, y)
    features = tile if only is None else tile.only(only)
    if features is None:
        return None
    materials = material_arrays_of(slice_rows(network, network_classes(network), features.rows))
    steepest = (network.steepest_gain_percent[features.rows], network.steepest_loss_percent[features.rows])
    return features, materials, network_fills(network, burden_material_ids(axes)), steepest


def _tile_lens(features: LensFeatures, materials: EdgeMaterialColumns, axes: CostAxisDefinitions, fills: MaterialFills,
               speed_kmh: float, preference: CostPreference, wind: tuple[WindForecastSeries, datetime] | None,
               steepest: tuple[np.ndarray, np.ndarray]) -> _TileLens:
    components = None
    if wind is not None:
        series, target = wind
        components = WindContext(
            bearing_deg=materials.bearing_deg, departure_wind=None, wind_series=series,
            forecast_index=series.time_index(target, 0.0),
            wind_points=series.lattice.points_of(materials.mid_lat, materials.mid_lon)).components_or_calm()
    return _TileLens(*lens_table(features, materials.columns, materials.distance_m, materials.elevation_profiles, axes,
                                 current_ledger_parameters(preference), speed_kmh, fills, components, steepest))


def _way_materials(table: LensTable, lens_id: str) -> dict[str, dict[str, float]] | None:
    values = table.values.get(lens_id)
    if values is None:
        return None
    features = table.features
    result: dict[str, dict[str, float]] = {}
    for key, (along, against), bearing in zip(features.keys, values.tolist(), features.bearing_deg.tolist()):
        # NaN（辿れない向き・方位の無い道）は自分と等しくない。
        leaves = {name: value for name, value in ((LENS_ALONG_LEAF, along), (LENS_AGAINST_LEAF, against),
                                                  (ROAD_BEARING_LEAF, bearing)) if value == value}
        if LENS_ALONG_LEAF in leaves or LENS_AGAINST_LEAF in leaves:
            result[key] = leaves
    return result
