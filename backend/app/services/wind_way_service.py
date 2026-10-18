"""鍵→道ごとの材料の配信層（風）。

道ごとの材料は、その道の中ほどの風速・風向で、走行方位と想定速度には依らない。走行方位・想定速度は**ユーザーが
指定した単一の値**（全道路共通）で、地図と配信が式の木（`domain/wind.py: WIND_DRAG_RATIO_WAY_FORMULA`）で当てる
（ルートを出す前は道を走る向きが決まっていない）。予報の地点と時刻の選び方はルートの区間と同じ
（`domain/wind.py: WindLattice`・`domain/wind.py: WindForecastSeries`）で、値の式もルートの区間と同じ式の木から
組む（`domain/wind.py: wind_drag_ratio_formula`）。

制御フローの詳細はdocs/modules/backend/dynamic-way-values.md「`WindWayService`」節参照。
"""

from dataclasses import dataclass
from datetime import datetime

import numpy as np

from app.domain.dynamic_way_values import ServedMaterialFormula
from app.domain.material_catalog import WIND_DRAG_RATIO
from app.domain.region import BoundingBox, tile_bounds_lonlat
from app.domain.time_zone import JST, as_series_time
from app.domain.wind import WIND_DIRECTION_LEAF, WIND_DRAG_RATIO_WAY_FORMULA, WIND_SPEED_LEAF
from app.infrastructure.debug_log import log_external_call, log_throttled_warning
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.services.feature_midpoints import feature_midpoint_arrays
from app.services.weather_service import WeatherService

_CATEGORY = "region:wind-way-penalty"


@dataclass(frozen=True)
class WindConditions:
    """風の値に要る条件。時刻を省略すると今の風。"""

    bearing_deg: float
    speed_kmh: float
    at: datetime | None = None


class WindWayService:
    def __init__(self, repository: RoadGraphRepository, weather_service: WeatherService):
        self._repository = repository
        self._weather_service = weather_service

    #: 返す生値の材料id。この材料を参照する軸の配信を担当する。
    material_id = WIND_DRAG_RATIO
    material_ids = (material_id,)
    conditions_type = WindConditions

    @classmethod
    def build(cls, repository: RoadGraphRepository, weather_service: WeatherService, material_id: str) -> "WindWayService":
        """登録テーブルから呼ぶための統一シグネチャ。依存の要否はサービスごとに違い、風の材料は1つだけ。"""
        return cls(repository=repository, weather_service=weather_service)

    @classmethod
    def material_formula(cls, material_id: str) -> ServedMaterialFormula:
        return ServedMaterialFormula(WIND_DRAG_RATIO_WAY_FORMULA)

    async def get_way_materials(self, z: int, x: int, y: int, at: datetime | None) -> dict[str, dict[str, float]]:
        """指定タイル内のフィーチャーごとの、時刻`at`（省略すると今）の風速（m/s）と風向（度）。

        取込範囲外・風データ取得不能・予報の範囲の外の時刻はいずれも空dictへ倒し、「この道路に
        色が付かない」という劣化で済ませる。
        """
        target = as_series_time(at or datetime.now(JST))
        bbox = tile_bounds_lonlat(z, x, y)

        with log_external_call(_CATEGORY, z=z, x=x, y=y) as fields:
            features = await feature_midpoint_arrays(self._repository, z, x, y, bbox, fields)
            if features is None:
                return {}
            keys, latitudes, longitudes = features
            # タイルをまたぐ道の中ほどはタイルの外にありうるため、格子はタイルと中ほどの両方を覆う。
            series = await self._weather_service.get_wind_forecast_lattice(BoundingBox(
                min_latitude=min(bbox.min_latitude, float(latitudes.min())),
                min_longitude=min(bbox.min_longitude, float(longitudes.min())),
                max_latitude=max(bbox.max_latitude, float(latitudes.max())),
                max_longitude=max(bbox.max_longitude, float(longitudes.max())),
            ))
            if series is None:
                fields["wind_grid"] = "unavailable"
                log_throttled_warning(_CATEGORY, "風の評価軸配信の風グリッド取得に失敗 z=%d x=%d y=%d", z, x, y)
                return {}
            # ルートの区間は予報の先を端の値で延ばすが、地図では延ばした値を当てにならない色として
            # 見せないよう塗らない。
            if not series.covers(target):
                fields["wind_grid"] = "out_of_range"
                log_throttled_warning(_CATEGORY, "風の評価軸配信の時刻が風グリッド範囲外 z=%d x=%d y=%d", z, x, y)
                return {}

            speed, direction = series.sample(target, np.zeros(len(keys)), series.lattice.points_of(latitudes, longitudes))
            fields["computed"] = len(keys)
            # 値はキャッシュしない（docs/modules/backend/dynamic-way-values.md「キャッシュ」節）。
            return {
                WIND_SPEED_LEAF: {key: float(value) for key, value in zip(keys, speed) if not np.isnan(value)},
                WIND_DIRECTION_LEAF: {key: float(value) for key, value in zip(keys, direction) if not np.isnan(value)},
            }
