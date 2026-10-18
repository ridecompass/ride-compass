"""鍵→勾配（gradient_percent）配信層。

`gradient_percent`は道路の始点→終点方向を基準にした符号付き値で、走行方位での符号は道路自身の向きで決まる。
そのため道ごとの材料として、道自身の勾配と道の向きを配る——走行方位は受け取らず、勾配の符号は式の木
（`domain/gradient.py: travel_direction_formula`）が当てる。
"""

from dataclasses import dataclass
from datetime import datetime

import numpy as np

from app.domain.dynamic_way_values import FeatureSegments, ServedMaterialFormula, by_direction_material
from app.domain.gradient import GRADIENT_VALUE_DECIMALS, ROAD_BEARING_LEAF, gradient_by_direction
from app.domain.material_catalog import GRADIENT_PERCENT
from app.domain.region import tile_bounds_lonlat
from app.domain.way_value_formula import feature
from app.infrastructure.cache_identity import cache_identity
from app.infrastructure.debug_log import log_external_call
from app.infrastructure.dynamic_way_value_cache import TileWayMaterials, get_tile_materials, set_tile_materials
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.infrastructure.road_tile_sql import FEATURE_GRADIENT_INPUTS_SHAPE, ROAD_SURFACE_TILE_SHAPE
from app.services.feature_midpoints import tile_features
from app.services.tile_version_service import served_tile_version

#: 勾配の道ごとの材料の作り方の署名。キャッシュの鍵に入り、変われば勾配のタイルの材料だけを作り直す。
#: 入力のSQL・丸めは機械で署名する。材料の作り方を変えたときは先頭のリビジョンを上げる——関数のソースは署名しない
#: （.claude/rules/caching-retention.md「無効化」）。
GRADIENT_VALUE_SHAPE = cache_identity("3", FEATURE_GRADIENT_INPUTS_SHAPE, GRADIENT_VALUE_DECIMALS)


@dataclass(frozen=True)
class GradientConditions:
    """勾配の値に要る条件。勾配は時刻にも速度にも依らない。"""

    bearing_deg: float


class GradientWayService:
    #: 返す生値の材料id。この材料を参照する軸の配信を担当し、キャッシュの名前空間にもなる。
    material_id = GRADIENT_PERCENT
    material_ids = (material_id,)
    conditions_type = GradientConditions

    def __init__(self, repository: RoadGraphRepository):
        self._repository = repository

    @classmethod
    def build(cls, repository: RoadGraphRepository, weather_service: object, material_id: str) -> "GradientWayService":
        """登録テーブルから呼ぶための統一シグネチャ。勾配は天候を要らず、材料は1つだけ。"""
        return cls(repository=repository)

    @classmethod
    def material_formula(cls, material_id: str) -> ServedMaterialFormula:
        """走行方位での勾配（%、正=登り・負=下り）。走行方位に直角に近い道は、どちら向きにも辿れて符号が決まらない
        （値を0%として配ると、実際には急な坂の道が凡例の「平坦」の段へ入り区別できなくなる）。"""
        return by_direction_material(*gradient_by_direction(feature(GRADIENT_PERCENT)))

    async def get_way_materials(self, z: int, x: int, y: int, at: datetime | None) -> TileWayMaterials:
        """指定タイル内のフィーチャーごとの、道自身の勾配（`GRADIENT_VALUE_DECIMALS`桁）と道の向き（度）。勾配は時刻に
        依らない。取込範囲外・DB障害はいずれも空dictへ倒す。"""
        bbox = tile_bounds_lonlat(z, x, y)

        with log_external_call("region:gradient-way-values", z=z, x=x, y=y) as fields:
            # 路面タイルの世代は鍵の一部。渡し忘れると世代をまたいだ値を配る。
            surface_tile_version = await served_tile_version(self._repository, ROAD_SURFACE_TILE_SHAPE)
            cached = await get_tile_materials(
                self.material_id, z, x, y, surface_tile_version=surface_tile_version, value_shape=GRADIENT_VALUE_SHAPE,
            )
            if cached is not None:
                fields["cache"] = "hit"
                fields["value_count"] = len(cached.get(GRADIENT_PERCENT, {}))
                return cached
            fields["cache"] = "miss"

            inputs = await tile_features(self._repository.get_feature_gradient_inputs_in_tile(z, x, y, bbox), fields)
            if inputs is None:
                return {}
            materials: TileWayMaterials = {
                GRADIENT_PERCENT: {
                    key: round(gradient_percent, GRADIENT_VALUE_DECIMALS)
                    for key, (gradient_percent, _) in inputs.items()
                },
                ROAD_BEARING_LEAF: {key: road_bearing_deg for key, (_, road_bearing_deg) in inputs.items()},
            }
            await set_tile_materials(
                self.material_id, z, x, y, materials,
                surface_tile_version=surface_tile_version, value_shape=GRADIENT_VALUE_SHAPE,
            )
            fields["computed"] = len(inputs)
            return materials

    def segment_materials(self, segments: FeatureSegments) -> dict[str, np.ndarray]:
        """区間ごとの道自身の勾配と、区間が属する道の両端を結ぶ方位。区間の勾配の符号を道1本のフィーチャーの値と同じ
        向きで決めるため——区間の方位で決めると、つづら折りの区間の符号が反転する。"""
        return {
            GRADIENT_PERCENT: np.asarray(segments.columns[self.material_id], dtype=float),
            ROAD_BEARING_LEAF: np.asarray(segments.feature_bearing_deg, dtype=float),
        }
