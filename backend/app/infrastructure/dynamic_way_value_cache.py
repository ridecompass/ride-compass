"""配信サービスの道ごとの材料（`{材料の名前: {feature_key: 値}}`）のディスクキャッシュ。

鍵は`(路面タイルの世代, material_id, 材料の値の作り方の署名, z, x, y)`で、要求の条件（走行方位・想定速度）は入らない——
値は条件に依らない道ごとの材料。世代と署名は呼び出し側が必須キーワードで渡すので、新しい材料で渡し忘れるとその場で失敗する。
"""

from app.infrastructure.tile_persistent_cache import get_tile_entry, set_tile_entry

#: 材料の名前→`{フィーチャー鍵: 値}`。
TileWayMaterials = dict[str, dict[str, float]]


def _key(material_id: str, z: int, x: int, y: int, surface_tile_version: str, value_shape: str) -> tuple:
    return ("dynway", surface_tile_version, material_id, value_shape, z, x, y)


async def get_tile_materials(
    material_id: str, z: int, x: int, y: int, *, surface_tile_version: str, value_shape: str,
) -> TileWayMaterials | None:
    """タイルの道ごとの材料。未キャッシュ・読み出し失敗はいずれもNoneで、値の無いタイルは空のdictで返る。"""
    return await get_tile_entry(_key(material_id, z, x, y, surface_tile_version, value_shape))


async def set_tile_materials(
    material_id: str, z: int, x: int, y: int, materials: TileWayMaterials, *, surface_tile_version: str, value_shape: str,
) -> None:
    await set_tile_entry(
        _key(material_id, z, x, y, surface_tile_version, value_shape),
        {name: dict(values) for name, values in materials.items()}, surface_tile_version=surface_tile_version)
