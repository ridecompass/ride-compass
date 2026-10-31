"""地図の配信が読む、タイル1枚ぶんのフィーチャーごとの材料（`domain/dynamic_way_values.py: FeatureMaterials`）と、フィーチャーごとの
区間の材料（`domain/dynamic_way_values.py: FeatureSegments`）のディスクキャッシュ。どちらを持つかは読み出しの形の署名で分かれる。

鍵は`(路面タイルの世代, 読み出しの形の署名, z, x, y)`で、軸の定義・走行方位・時刻を入れない（材料はどれにも依らない）。
世代と署名は呼び出し側が必須キーワードで渡す（infrastructureからは世代を読まない）。
"""

from typing import TypeVar

from app.domain.dynamic_way_values import FeatureMaterials, FeatureSegments
from app.infrastructure.tile_persistent_cache import get_tile_entry, set_tile_entry

_Materials = TypeVar("_Materials", FeatureMaterials, FeatureSegments)


def _key(z: int, x: int, y: int, surface_tile_version: str, value_shape: str) -> tuple:
    return ("featmat", surface_tile_version, value_shape, z, x, y)


async def get_tile_materials(
    z: int, x: int, y: int, *, surface_tile_version: str, value_shape: str, kind: type[_Materials]
) -> _Materials | None:
    """タイルの材料（`kind`の値）。未キャッシュ・読み出し失敗はいずれもNone（フィーチャーの無いタイルは0行の値で返る）。"""
    cached = await get_tile_entry(_key(z, x, y, surface_tile_version, value_shape))
    return cached if isinstance(cached, kind) else None


async def set_tile_materials(
    z: int, x: int, y: int, materials: FeatureMaterials | FeatureSegments, *, surface_tile_version: str, value_shape: str
) -> None:
    await set_tile_entry(
        _key(z, x, y, surface_tile_version, value_shape), materials, surface_tile_version=surface_tile_version)
