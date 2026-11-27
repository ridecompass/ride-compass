"""`infrastructure/jma_tile_recolor.py`——気象庁のタイルの色を、アプリの段の描き方へ塗り替える（降水は段の色へ、
段で塗る災害は注意の段を薄く）。

入口は`recolored`。タイルは配信元と同じ形式（降水とキキクルはパレット形式、雷はRGBA）の画像をテストの中で作る。

ここで見ないもの:
- 取得したタイルが塗り替えられてキャッシュへ入ること → `test_jma_tile_client.py`
"""

import io

import pytest
from PIL import Image, ImageColor

from app.domain.map_display import HAZARD_OPACITY
from app.domain.weather_display import (
    ATTENTION_LEVEL_OPACITY,
    PRECIPITATION_COLOR_STOPS,
    RISK_LEVEL_COLORS,
    THUNDER_ACTIVITY_LEVELS,
    TORNADO_POTENTIAL_LEVELS,
    LevelColor,
    RiskLevel,
)
from app.infrastructure.jma_tile_recolor import (
    JMA_PRECIPITATION_TILE_COLORS,
    JMA_UNPAINTED_PRECIPITATION_TILE_COLOR,
    recolored,
)
from tests.tile_images import palette_tile, pixels, rgba, rgba_tile

FRAME = "bosai/jmatile/data/nowc/20260101000000/none/20260101000500/surf"
PRECIPITATION = f"{FRAME}/hrpns/6/57/25.png"
THUNDER = f"{FRAME}/thns/6/57/25.png"
TORNADO = f"{FRAME}/trns/6/57/25.png"
LANDSLIDE = "bosai/jmatile/data/risk/20260101000000/none/20260101000000/surf/land/6/57/25.png"
RAINBAND_FORECAST = "bosai/jmatile/data/rasrf/20260101000000/none/20260101000000/surf/sjfcstmap/6/57/25.png"


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


def _measured(levels: tuple[LevelColor | RiskLevel, ...]) -> list[LevelColor | RiskLevel]:
    return [level for level in levels if level.tile_color is not None]


@pytest.mark.parametrize(
    ("path", "tile", "levels"),
    [
        (THUNDER, rgba_tile, _measured(THUNDER_ACTIVITY_LEVELS)),
        (TORNADO, rgba_tile, _measured(TORNADO_POTENTIAL_LEVELS)),
        (LANDSLIDE, palette_tile, _measured(RISK_LEVEL_COLORS) + [RISK_LEVEL_COLORS[2]._replace(tile_color="#ff2800")]),
    ],
)
def test_attention_levels_are_thinned_and_painted_levels_are_kept(path, tile, levels):
    """注意の段は地図で見える濃さが`ATTENTION_LEVEL_OPACITY`になり、塗る段は今のまま描かれる（色はどの段も変えない）。"""
    content = tile([level.tile_color for level in levels])

    drawn = pixels(recolored(path, content))[1:]

    for level, pixel in zip(levels, drawn, strict=True):
        assert pixel[:3] == rgba(level.tile_color)[:3]
        if level.painted:
            assert pixel[3] == 255
        else:
            assert pixel[3] / 255 * HAZARD_OPACITY == pytest.approx(ATTENTION_LEVEL_OPACITY, abs=0.005)


def test_attention_pixels_already_fainter_than_the_target_stay_faint():
    """配信元が既に薄く描いた画素（縁のぼかし等）を、薄くする処理で濃くしない（パレット形式と同じ扱い）。"""
    attention = next(level for level in THUNDER_ACTIVITY_LEVELS if not level.painted)
    image = Image.new("RGBA", (1, 1), (*ImageColor.getrgb(attention.tile_color), 20))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")

    assert pixels(recolored(THUNDER, buffer.getvalue()))[0][3] == 20


def test_colors_missing_from_the_level_table_are_read_as_the_nearest_level_and_warned(caplog):
    """段の表の測った色に無い画素（配信元の配色の変更・まだ測れていない段）は、いちばん近い色の段として扱い（画面の範囲の印と
    同じ段）、警告を出す。"""
    attention = next(level for level in THUNDER_ACTIVITY_LEVELS if not level.painted)
    red, green, blue = ImageColor.getrgb(attention.tile_color)
    near_attention = f"#{red - 2:02x}{green - 2:02x}{blue + 2:02x}"
    painted = rgba_tile(["#123456"])

    assert recolored(THUNDER, painted) == painted
    assert pixels(recolored(THUNDER, rgba_tile([near_attention])))[1][3] < 255
    assert "missing from the level table" in caplog.text


def test_other_tiles_are_served_as_they_came():
    content = palette_tile(list(JMA_PRECIPITATION_TILE_COLORS))
    assert recolored(RAINBAND_FORECAST, content) == content
