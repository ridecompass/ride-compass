"""地図の道の線の層が読む、タイル1枚ぶんのフィーチャーごとの材料（`domain/feature_materials.py: FeatureMaterials`）の
ディスクキャッシュ。

鍵は`(読み出しの形の署名, z, x, y)`で、軸の定義・走行方位・時刻を入れない（材料はどれにも依らない）。署名は呼び出し側が必須
キーワードで渡す。DBの中身は鍵に入れず、派生の表を作り直したら`discard_all`で捨てる。
"""

from app.domain.feature_materials import FeatureMaterials
from app.infrastructure.tile_persistent_cache import delete_namespace, get_tile_entry, set_tile_entry

_NAMESPACE = "featmat"


def _key(z: int, x: int, y: int, value_shape: str) -> tuple:
    return (_NAMESPACE, value_shape, z, x, y)


async def get_tile_materials(z: int, x: int, y: int, *, value_shape: str) -> FeatureMaterials | None:
    """タイルの材料。未キャッシュ・読み出し失敗はいずれもNone（フィーチャーの無いタイルは0行の値で返る）。"""
    cached = await get_tile_entry(_key(z, x, y, value_shape))
    return cached if isinstance(cached, FeatureMaterials) else None


async def set_tile_materials(z: int, x: int, y: int, materials: FeatureMaterials, *, value_shape: str) -> None:
    await set_tile_entry(_key(z, x, y, value_shape), materials)


def discard_all() -> None:
    """持っている材料を全部消す。"""
    delete_namespace(_NAMESPACE)
