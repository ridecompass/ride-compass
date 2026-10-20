"""`infrastructure/jma_tile_content.py`——気象庁のタイルに描くものが無いかの判定。

入口は`is_empty_tile`。空と誤って判じると、キャッシュも在否インデックスも「取りに行かなくてよい」と
扱い、危険度の色が地図に出なくなる。迷う入力は「中身あり」に倒れることを見る。

ここで見ないもの:
- 空と判じたタイルをフラグで持つこと → `test_jma_tile_redis_cache.py`
- 在否インデックスへ載せないこと → `test_jma_tile_prewarm_service.py`
"""

import io

from PIL import Image

from app.infrastructure.jma_tile_content import is_empty_tile

SIZE = 256


def encode(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_a_palette_raster_whose_every_pixel_is_the_transparent_entry_is_empty():
    """配信元のタイルの形（パレットの0番を透明にした画像）。"""
    image = Image.new("P", (SIZE, SIZE), 0)
    image.putpalette([0, 0, 0, 255, 40, 0] + [0, 0, 0] * 254)
    image.info["transparency"] = 0

    assert is_empty_tile(encode(image), "png")
