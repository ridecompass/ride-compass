"""テストの中で作るタイルの画像（PNG）の組み立てと読み戻し。

気象庁・地理院のタイルを扱うテストが、入力の画像をPNGのバイト列にし、出力のバイト列を画素へ戻すのに使う。
"""

import io

from PIL import Image, ImageColor


def encode(image: Image.Image, **options) -> bytes:
    """`image`をPNGのバイト列にする。`options`は`Image.save`へそのまま渡す（`transparency`等）。"""
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", **options)
    return buffer.getvalue()


def palette_tile(colors: list[str]) -> bytes:
    """1列目を透明にし、2列目から`colors`を1画素ずつ並べたパレット形式のPNG（気象庁の降水のタイルと同じ形式）。"""
    image = Image.new("P", (len(colors) + 1, 1), 0)
    image.putpalette([0, 0, 0, *(value for color in colors for value in ImageColor.getrgb(color))])
    image.putdata(range(len(colors) + 1))
    return encode(image, transparency=0)


def pixels(content: bytes) -> list[tuple[int, int, int, int]]:
    """PNGのバイト列の画素を、左上から行ごとにRGBAで並べる。"""
    with Image.open(io.BytesIO(content)) as image:
        return list(image.convert("RGBA").get_flattened_data())


def rgba(color: str) -> tuple[int, int, int, int]:
    """色の文字列（`#rrggbb`）を不透明のRGBAにする。"""
    return (*ImageColor.getrgb(color), 255)
