"""地図の道の線の層が区分を塗る、タイル1枚ぶんのフィーチャーごとの材料を読む（路面タイルの世代ごとにディスクへ持つ）。"""

from collections.abc import Awaitable
from typing import Any

from app.domain.feature_materials import FeatureMaterials
from app.domain.road_classes import RoadClassDefinitions, class_columns, current_road_classes, layer_columns
from app.domain.region import tile_bounds_lonlat
from app.infrastructure.cache_identity import cache_identity
from app.infrastructure.database import DB_UNAVAILABLE_ERRORS
from app.infrastructure.debug_log import log_external_call, mark_failed
from app.infrastructure.feature_material_cache import get_tile_materials, set_tile_materials
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.infrastructure.road_tile_sql import FEATURE_MATERIALS_SHAPE, ROAD_SURFACE_TILE_SHAPE
from app.services.tile_version_service import served_tile_version

#: 材料の値の読み方の署名。キャッシュの鍵に入り、読み出しのSQLか持つ列の組を変えれば作り直す。
FEATURE_MATERIALS_VALUE_SHAPE = cache_identity("1", FEATURE_MATERIALS_SHAPE, FeatureMaterials)


async def _tile_features(read: Awaitable[FeatureMaterials | None], fields: dict[str, Any]) -> FeatureMaterials | None:
    """タイル内のフィーチャーごとの材料を読む。

    DB障害・取込範囲外・フィーチャーが無いタイルは None（どれだったかは`fields`へ記録する）。
    """
    try:
        features = await read
    except DB_UNAVAILABLE_ERRORS as exc:
        mark_failed(fields, exc)
        return None
    if not features:
        fields["postgis"] = "uncovered" if features is None else "empty"
        return None
    fields["feature_count"] = len(features)
    return features


class FeatureMaterialService:
    def __init__(self, repository: RoadGraphRepository):
        self._repository = repository

    async def materials(
        self, z: int, x: int, y: int, definitions: RoadClassDefinitions | None = None
    ) -> FeatureMaterials | None:
        """タイル内のフィーチャーごとの材料。取込範囲外・DB障害・フィーチャーの無いタイルはNone。

        区分の列（`domain/road_classes.py: class_columns`）は、持っておいた事実へ読むたびに当てる。持つものに区分を含めないので、
        区分を書き換えても持ったものを作り直さずに済む。区分の全体は`definitions`（省けば今の全体）。"""
        materials = await self._cached(z, x, y)
        if materials is None:
            return None
        classes = class_columns(definitions or current_road_classes(), materials.columns, len(materials))
        return FeatureMaterials(feature_keys=materials.feature_keys, columns={**materials.columns, **classes})

    async def road_layer_values(self, z: int, x: int, y: int) -> dict[str, dict[str, str]]:
        """タイル内のフィーチャーごとの、地図の線の層の値（`domain/road_classes.py: layer_columns`）。値の無い層は載せない。"""
        definitions = current_road_classes()
        materials = await self.materials(z, x, y, definitions)
        if materials is None:
            return {}
        layers = layer_columns(definitions, materials.columns, len(materials))
        out: dict[str, dict[str, str]] = {}
        for row, key in enumerate(materials.feature_keys):
            if values := {layer: value for layer, column in layers.items() if (value := column.value_at(row)) is not None}:
                out[key] = values
        return out

    async def _cached(self, z: int, x: int, y: int) -> FeatureMaterials | None:
        value_shape = FEATURE_MATERIALS_VALUE_SHAPE
        with log_external_call("region:feature-materials", z=z, x=x, y=y) as fields:
            # 路面タイルの世代は鍵の一部。渡し忘れると世代をまたいだ鍵の材料を配る。
            surface_tile_version = await served_tile_version(self._repository, ROAD_SURFACE_TILE_SHAPE)
            cached = await get_tile_materials(
                z, x, y, surface_tile_version=surface_tile_version, value_shape=value_shape
            )
            if cached is not None:
                fields["cache"] = "hit"
                fields["feature_count"] = len(cached)
                return cached
            fields["cache"] = "miss"

            async def read_tile() -> FeatureMaterials | None:
                accident_years = await self._repository.get_accident_years_covered()
                return await self._repository.get_feature_materials_in_tile(z, x, y, tile_bounds_lonlat(z, x, y),
                                                                            accident_years)

            materials = await _tile_features(read_tile(), fields)
            if materials is not None:
                await set_tile_materials(
                    z, x, y, materials, surface_tile_version=surface_tile_version, value_shape=value_shape
                )
            return materials
