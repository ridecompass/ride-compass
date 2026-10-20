"""`infrastructure/dynamic_way_value_cache.py`——路面タイルのフィーチャーごとの材料のディスクキャッシュ
（`set_tile_materials`・`get_tile_materials`）。

置き場は`tests/conftest.py`のautouseがテストごとの空の一時ディレクトリへ差し替える。

ここで見ないもの:
- 置き場の読み書きに失敗したときに未キャッシュへ倒すこと・失効（TTLは置き場へそのまま渡す） → `test_tile_persistent_cache.py`
- どの材料をキャッシュし、どの世代・署名・TTLを渡すか → 材料のサービスのテスト（例: `test_gradient_way_service.py`）
"""

import pytest

from app.infrastructure.dynamic_way_value_cache import (
    get_tile_materials,
    set_tile_materials,
)

MATERIALS = {"material_a": {"way-1": 3.5, "way-2": -1.0}, "bearing": {"way-1": 30.0}}
KEY = {"material_id": "material_a", "z": 14, "x": 14550, "y": 6451}
VERSIONS = {"surface_tile_version": "tiles-1", "value_shape": "shape-1"}


@pytest.mark.parametrize(
    "other",
    [
        {},
        {"material_id": "material_b"},
        {"z": 15},
        {"x": 14551},
        {"y": 6452},
        # 路面タイルを作り直すとフィーチャーの鍵が変わり、前の世代の値はどの地物にも一致しない。
        {"surface_tile_version": "tiles-2"},
        # 材料の計算を変えたデプロイの後は、前の作り方の値を読まない。
        {"value_shape": "shape-2"},
    ],
)
async def test_only_a_read_with_the_same_key_sees_the_stored_materials(other):
    await set_tile_materials(**KEY, materials=MATERIALS, **VERSIONS)

    expected = MATERIALS if not other else None
    assert await get_tile_materials(**{**KEY, **VERSIONS, **other}) == expected
