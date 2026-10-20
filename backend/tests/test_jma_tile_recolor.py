"""`infrastructure/jma_tile_recolor.py`——気象庁の降水のタイルの色を、アプリの降水の段の色へ塗り替える。

入口は`recolored`。タイルは配信元と同じパレット形式（透明の項目と段の色の項目）の画像をテストの中で作る。

ここで見ないもの:
- 取得したタイルが塗り替えられてキャッシュへ入ること → `test_jma_tile_client.py`
"""

import pytest

from app.domain.weather_display import PRECIPITATION_COLOR_STOPS
from app.infrastructure.jma_tile_recolor import JMA_PRECIPITATION_TILE_COLORS, recolored
from tests.tile_images import palette_tile, pixels, rgba

FRAME = "bosai/jmatile/data/nowc/20260101000000/none/20260101000500/surf"
PRECIPITATION = f"{FRAME}/hrpns/6/57/25.png"
THUNDER = f"{FRAME}/thns/6/57/25.png"
UNKNOWN = "#123456"


def test_each_band_is_painted_with_the_legend_color_of_the_same_band():
    tile = palette_tile([*JMA_PRECIPITATION_TILE_COLORS, UNKNOWN])

    painted = pixels(recolored(PRECIPITATION, tile))

    assert painted[0][3] == 0
    assert painted[1:] == [*(rgba(stop.color) for stop in PRECIPITATION_COLOR_STOPS), rgba(UNKNOWN)]


@pytest.mark.parametrize(
    ("path", "content"),
    [
        (THUNDER, palette_tile(list(JMA_PRECIPITATION_TILE_COLORS))),
        (PRECIPITATION, b"\x89PNG broken"),
    ],
    ids=["not_precipitation", "unreadable"],
)
def test_other_tiles_and_unreadable_images_are_served_as_they_came(path, content):
    assert recolored(path, content) == content
