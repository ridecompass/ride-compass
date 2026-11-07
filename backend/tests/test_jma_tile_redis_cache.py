"""`infrastructure/jma_tile_redis_cache.py`——気象庁のタイルの本体をRedisへ持つ置き場。

入口は`get`・`set`・`set_empty`。Redisはfakeredis、時計はfreezegunで与える。

ここで見ないもの:
- どのタイルを空とみなすか → `test_jma_tile_content.py`。ここでは空の代表を1つずつ使う
- いつ`set_empty`を呼ぶか（確定した404） → `test_jma_tile_client.py`
- Redisの障害で何も持たず、例外を出さないこと → `test_redis_json_cache.py`（ここは`get_bytes`・`set_bytes`へ委ねるだけ）
- 一度も書いていないパスの外れ → 同じ。ここでは別のパスが外れるテストが通す
- 後から書いた値が前の値を置き換えること → Redisの`SET`の振る舞いで、ここに判断が無い
"""

import pytest
from PIL import Image

from app.infrastructure import jma_tile_redis_cache
from app.infrastructure.http_client import UPSTREAM_NOT_FOUND
from tests.tile_images import encode

TILE = "bosai/jmatile/data/risk/20260101000000/none/20260101000000/surf/land/10/908/403.png"
OTHER_TILE = "bosai/jmatile/data/risk/20260101000000/none/20260101000000/surf/land/10/908/404.png"
VECTOR_TILE = "bosai/jmatile/data/risk/20260101000000/none/20260101000000/surf/flood/10/908/403.pbf"


def png(alpha: int) -> bytes:
    return encode(Image.new("RGBA", (4, 4), (255, 0, 0, alpha)))


async def test_a_stored_tile_comes_back_byte_for_byte_with_its_content_type(fake_redis):
    """本体は区切りのNULを含みうる。区切りで本体を切ると、画像が途中で切れて壊れて届く。"""
    content = png(255) + b"\0trailing\0bytes"

    await jma_tile_redis_cache.set(TILE, content, "image/png; charset=binary")

    assert await jma_tile_redis_cache.get(TILE) == (content, "image/png; charset=binary")


async def test_each_path_keeps_its_own_entry(fake_redis):
    await jma_tile_redis_cache.set(TILE, png(255), "image/png")

    assert await jma_tile_redis_cache.get(OTHER_TILE) is None


@pytest.mark.parametrize(
    ("path", "content", "content_type"),
    [
        (TILE, png(0), "image/png"),
        # ベクタは長さで空を見る。画像として読もうとすると、空のベクタも「中身あり」で実体を持つ。
        (VECTOR_TILE, b"", "application/x-protobuf"),
    ],
    ids=["transparent_raster", "empty_vector"],
)
async def test_a_tile_with_nothing_to_draw_comes_back_as_the_flag(fake_redis, path, content, content_type):
    await jma_tile_redis_cache.set(path, content, content_type)

    assert await jma_tile_redis_cache.get(path) is UPSTREAM_NOT_FOUND


async def test_tiles_and_flags_are_forgotten_after_twenty_minutes(fake_redis, clock):
    """プリウォームの間隔（10分）より長く持ち、1回温め損ねても地図から消えない。"""
    await jma_tile_redis_cache.set(TILE, png(255), "image/png")
    await jma_tile_redis_cache.set_empty(OTHER_TILE)

    clock.tick(20 * 60 - 1)
    assert await jma_tile_redis_cache.get(TILE) is not None
    assert await jma_tile_redis_cache.get(OTHER_TILE) is not None
    clock.tick(2)
    assert await jma_tile_redis_cache.get(TILE) is None
    assert await jma_tile_redis_cache.get(OTHER_TILE) is None
