"""`domain/weather_display.py`——配信元のタイルの画素を段と見分ける色と、画素の段。

入口は`tile_pixel_colors`と`tile_pixel_level`。段は架空の色で組む。

ここで見ないもの:
- 見分けた段で注意の段の画素を薄くすること → `test_jma_tile_recolor.py`
- 画面の見分け方が同じ段を返すこと → 生成物`jma-expectations.json`の`tile_pixel_level`を画面のテストが当てる
"""

import pytest

from app.domain.weather_display import LevelColor, tile_pixel_colors, tile_pixel_level


def _level(color: str, tile_color: str | None, *, tile_drawn: bool = True) -> LevelColor:
    return LevelColor("key", "label", color, painted=False, tile_color=tile_color, tile_drawn=tile_drawn)


def test_pixel_colors_are_the_measured_tile_color_else_the_legend_color_and_none_for_undrawn_levels():
    """測れていない段も画素を見分けられ、配信元が描かない段の色（危険度の「平常」の白等）が画素の段の候補に入らない。"""
    levels = [_level("#ffffff", None, tile_drawn=False), _level("#f2e700", "#faf500"), _level("#ff2800", None)]

    assert tile_pixel_colors(levels) == (None, (0xFA, 0xF5, 0x00), (0xFF, 0x28, 0x00))


RED, GREEN = (255, 0, 0), (0, 255, 0)


@pytest.mark.parametrize(
    ("rgb", "colors", "expected"),
    [
        ((250, 10, 0), [RED, GREEN], 0),  # 測った色からずれた画素も、いちばん近い段
        ((10, 250, 0), [RED, GREEN], 1),
        ((128, 128, 0), [RED, GREEN], 0),  # 近さが同じなら先の段
        ((255, 255, 255), [None, GREEN], 1),  # 描かない段の色には寄せない
        ((255, 0, 0), [None, None], None),
    ],
)
def test_pixel_level_is_the_level_of_the_nearest_color(rgb, colors, expected):
    """段を取り違えると、注意の段でない画素を薄くし、地図の範囲の印が違う段を指す。"""
    assert tile_pixel_level(rgb, colors) == expected
