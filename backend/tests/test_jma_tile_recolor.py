"""`infrastructure/jma_tile_recolor.py`——気象庁の降水のタイルの色を、アプリの降水の段の色へ塗り替える。

入口は`recolored`。タイルは配信元と同じパレット形式（透明の項目と段の色の項目）の画像をテストの中で作る。

ここで見ないもの:
- 取得したタイルが塗り替えられてキャッシュへ入ること → `test_jma_tile_client.py`
"""


from app.domain.weather_display import PRECIPITATION_COLOR_STOPS
from app.infrastructure.jma_tile_recolor import (
    JMA_PRECIPITATION_TILE_COLORS,
    JMA_UNPAINTED_PRECIPITATION_TILE_COLOR,
    recolored,
)
from tests.tile_images import palette_tile, pixels, rgba

FRAME = "bosai/jmatile/data/nowc/20260101000000/none/20260101000500/surf"
PRECIPITATION = f"{FRAME}/hrpns/6/57/25.png"
THUNDER = f"{FRAME}/thns/6/57/25.png"


def test_each_band_is_painted_with_the_legend_color_of_the_same_band():
    tile = palette_tile(list(JMA_PRECIPITATION_TILE_COLORS))

    painted = pixels(recolored(PRECIPITATION, tile))

    assert painted[0][3] == 0
    assert painted[1:] == [rgba(stop.color) for stop in PRECIPITATION_COLOR_STOPS]


def test_rain_weaker_than_the_weakest_band_is_left_unpainted():
    """気象庁がほぼ白で描く弱い雨に色を付けると、気象庁の画面で降っていない所が地図では雨に見える。"""
    tile = palette_tile([JMA_UNPAINTED_PRECIPITATION_TILE_COLOR, JMA_PRECIPITATION_TILE_COLORS[0]])

    painted = pixels(recolored(PRECIPITATION, tile))

    assert [pixel[3] for pixel in painted] == [0, 0, 255]


def test_other_tiles_are_served_as_they_came():
    content = palette_tile(list(JMA_PRECIPITATION_TILE_COLORS))
    assert recolored(THUNDER, content) == content
