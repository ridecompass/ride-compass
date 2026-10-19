"""地図の配信が評価する、タイル1枚ぶんのフィーチャーごとの材料と、フィーチャーごとの区間の材料を読む（路面タイルの世代ごとに
ディスクへ持つ）。"""

from collections.abc import Awaitable, Callable
from typing import TypeVar

from app.domain.dynamic_way_values import FeatureMaterials, FeatureSegments
from app.domain.road_classes import class_columns, current_road_classes, layer_columns
from app.domain.region import tile_bounds_lonlat
from app.infrastructure.cache_identity import cache_identity, is_known_tile_version
from app.infrastructure.debug_log import log_external_call
from app.infrastructure.feature_material_cache import get_tile_materials, set_tile_materials
from app.infrastructure.road_graph_repository import RoadGraphRepository
from app.infrastructure.road_tile_sql import FEATURE_MATERIALS_SHAPE, FEATURE_SEGMENTS_SHAPE, ROAD_SURFACE_TILE_SHAPE
from app.services.feature_midpoints import tile_features
from app.services.tile_version_service import served_tile_version

#: 材料の値の読み方の署名。キャッシュの鍵に入り、読み出しのSQLか持つ列の組を変えれば作り直す。
FEATURE_MATERIALS_VALUE_SHAPE = cache_identity("1", FEATURE_MATERIALS_SHAPE, FeatureMaterials)
#: 区間の材料の読み方の署名。同上。
FEATURE_SEGMENTS_VALUE_SHAPE = cache_identity("1", FEATURE_SEGMENTS_SHAPE, FeatureSegments)

_Materials = TypeVar("_Materials", FeatureMaterials, FeatureSegments)


class FeatureMaterialService:
    def __init__(self, repository: RoadGraphRepository):
        self._repository = repository

    async def materials(self, z: int, x: int, y: int) -> FeatureMaterials | None:
        """タイル内のフィーチャーごとの材料。取込範囲外・DB障害・フィーチャーの無いタイルはNone。

        区分の列（`domain/road_classes.py: class_columns`）は、持っておいた事実へ読むたびに当てる。持つものに区分を含めないので、
        区分を書き換えても持ったものを作り直さずに済む。"""
        materials = await self._cached(
            "region:feature-materials", z, x, y, FeatureMaterials, FEATURE_MATERIALS_VALUE_SHAPE,
            self._repository.get_feature_materials_in_tile,
        )
        if materials is None:
            return None
        classes = class_columns(current_road_classes(), materials.columns, len(materials))
        return FeatureMaterials(feature_keys=materials.feature_keys, columns={**materials.columns, **classes})

    async def road_layer_values(self, z: int, x: int, y: int) -> dict[str, dict[str, str]]:
        """タイル内のフィーチャーごとの、地図の線の層の値（`domain/road_classes.py: layer_columns`）。値の無い層は載せない。"""
        materials = await self.materials(z, x, y)
        if materials is None:
            return {}
        layers = layer_columns(current_road_classes(), materials.columns, len(materials))
        out: dict[str, dict[str, str]] = {}
        for row, key in enumerate(materials.feature_keys):
            if values := {layer: value for layer, column in layers.items() if (value := column.value_at(row)) is not None}:
                out[key] = values
        return out

    async def segments(self, z: int, x: int, y: int) -> FeatureSegments | None:
        """道1本を1つのフィーチャーにするズームのタイルの、フィーチャーごとの区間の材料。取込範囲外・DB障害・区間の無い
        タイルはNone。"""
        return await self._cached(
            "region:feature-segments", z, x, y, FeatureSegments, FEATURE_SEGMENTS_VALUE_SHAPE,
            self._repository.get_feature_segments_in_tile,
        )

    async def _cached(
        self,
        category: str,
        z: int,
        x: int,
        y: int,
        kind: type[_Materials],
        value_shape: str,
        read: Callable[..., Awaitable[_Materials | None]],
    ) -> _Materials | None:
        with log_external_call(category, z=z, x=x, y=y) as fields:
            # 路面タイルの世代は鍵の一部。渡し忘れると世代をまたいだ鍵の材料を配る。
            surface_tile_version = await served_tile_version(self._repository, ROAD_SURFACE_TILE_SHAPE)
            cached = await get_tile_materials(
                z, x, y, surface_tile_version=surface_tile_version, value_shape=value_shape, kind=kind
            )
            if cached is not None:
                fields["cache"] = "hit"
                fields["feature_count"] = len(cached)
                return cached
            fields["cache"] = "miss"

            async def read_tile() -> _Materials | None:
                accident_years = await self._repository.get_accident_years_covered()
                return await read(z, x, y, tile_bounds_lonlat(z, x, y), accident_years)

            materials = await tile_features(read_tile(), fields)
            if materials is not None and is_known_tile_version(surface_tile_version):
                await set_tile_materials(
                    z, x, y, materials, surface_tile_version=surface_tile_version, value_shape=value_shape
                )
            return materials
