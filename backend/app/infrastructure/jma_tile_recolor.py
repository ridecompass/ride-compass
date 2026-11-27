"""気象庁のタイルの色を、アプリの段の描き方へ塗り替える。

- 降水: 配信元は降水の強さの段ごとに決まった色で塗ったパレット形式のPNGを配り、段の区切りはアプリの降水の段
  （`domain/weather_display.py: PRECIPITATION_COLOR_STOPS`）と同じなので、パレットの色を1対1で替えれば、地図の色と
  凡例（同じ段から組み立てる）が一致する。アプリが塗らない段（いちばん弱い段の下限より弱い雨）の色は透明にする。
  画素は書き換えずパレットとその透明度だけを替え、パレット形式のまま配る。
- 段で塗る災害（雷・竜巻・キキクル）: 注意の段（段の表の`painted`がFalse）の画素だけを、地図で見える濃さが
  `ATTENTION_LEVEL_OPACITY`になる不透明度へ下げる。色と段は変えない（段を1対1のまま、見せる濃さだけを替える）。
  段の表に色の無い画素は、そのまま返して警告を1度だけ出す（配信元の配色が変わったか、まだ測れていない段）。
"""

import io
import logging
from typing import cast

import numpy as np
from PIL import Image, ImageColor

from app.domain.jma_tile_specs import jma_tile_spec
from app.domain.map_display import AREA_OPACITY
from app.domain.weather_display import ATTENTION_LEVEL_OPACITY, PRECIPITATION_COLOR_STOPS
from app.domain.weather_elements import LEVELS_OF_SCALE, WEATHER_ELEMENTS
from app.infrastructure.cache_identity import shape_digest
from app.infrastructure.jma_tile_paths import read_jma_tile_path
from app.infrastructure.simple_api_client import UnexpectedShapeError

#: 気象庁の降水のタイル（降水ナウキャスト・降水短時間予報）が段を塗る色を、`PRECIPITATION_COLOR_STOPS`と同じ段の順に
#: 並べたもの。配信元のタイルのパレットの色。
JMA_PRECIPITATION_TILE_COLORS: tuple[str, ...] = (
    "#a0d2ff", "#218cff", "#0041ff", "#faf500", "#ff9900", "#ff2800", "#b40068",
)

#: 気象庁の降水のタイルが、`PRECIPITATION_COLOR_STOPS`のいちばん弱い段より弱い雨を塗る色。アプリは塗らない。
JMA_UNPAINTED_PRECIPITATION_TILE_COLOR = "#f2f2ff"

_UNPAINTED = ImageColor.getrgb(JMA_UNPAINTED_PRECIPITATION_TILE_COLOR)

_PRECIPITATION_COLORS: dict[tuple[int, ...], tuple[int, ...]] = {
    ImageColor.getrgb(jma): ImageColor.getrgb(stop.color)
    for jma, stop in zip(JMA_PRECIPITATION_TILE_COLORS, PRECIPITATION_COLOR_STOPS, strict=True)
}

logger = logging.getLogger("ridecompass.jma_tile_recolor")

RGB = tuple[int, ...]


def _level_tile_colors() -> dict[str, tuple[frozenset[RGB], frozenset[RGB]]]:
    """配信要素id → （段の表が色を持つ全部の段の色, そのうち注意の段の色）。段で塗る要素だけを持つ。"""
    colors: dict[str, tuple[frozenset[RGB], frozenset[RGB]]] = {}
    for element in WEATHER_ELEMENTS:
        if element.level_scale is None or element.kind != "rasterTile":
            continue
        levels = [level for level in LEVELS_OF_SCALE[element.level_scale] if level.tile_color is not None]
        known = frozenset(ImageColor.getrgb(cast("str", level.tile_color)) for level in levels)
        attention = frozenset(ImageColor.getrgb(cast("str", level.tile_color)) for level in levels if not level.painted)
        for element_id in element.jma_elements:
            colors[element_id] = (known, attention)
    return colors


_LEVEL_TILE_COLORS = _level_tile_colors()

#: 注意の段の画素の不透明度。画面は配信元のタイルを地図の面の濃さ（`AREA_OPACITY`）で重ねるので、掛けて
#: `ATTENTION_LEVEL_OPACITY`になる値にする。
_ATTENTION_ALPHA = round(255 * ATTENTION_LEVEL_OPACITY / AREA_OPACITY)

#: 警告を出した（配信要素id, 色）。同じ色はタイルごとに何度も来るので、プロセスで1度だけ出す。
_warned_unknown: set[tuple[str, RGB]] = set()

#: 塗り替えの版。タイル本体のキャッシュの鍵に入れ、色の対応を変えたら前の色で保存したタイルを読まない。
RECOLOR_VERSION = shape_digest(
    [
        sorted(_PRECIPITATION_COLORS.items()),
        _UNPAINTED,
        sorted((key, sorted(known), sorted(attention)) for key, (known, attention) in _LEVEL_TILE_COLORS.items()),
        _ATTENTION_ALPHA,
    ]
)


def recolored(path: str, content: bytes) -> bytes:
    """宣言が降水の段の色を持つ要素のタイルなら色を塗り替え、段で塗る災害の要素のタイルなら注意の段の画素を薄くした
    PNGを返す。それ以外はそのまま返す。

    降水: パレット形式でない画像（配信元が空のタイルに返すRGBA）は塗る画素を持たないので、そのまま返す。
    降水の段に無い色の画素があれば投げる（配信元が配色を変えた印。塗り替えずに残すと、凡例に無い色を描かせる）。
    読めない画像も投げる。"""
    tile = read_jma_tile_path(path)
    if tile is None:
        return content
    level_colors = _LEVEL_TILE_COLORS.get(tile.element_id)
    if not jma_tile_spec(tile.element_id).precipitation_colors and level_colors is None:
        return content
    try:
        if level_colors is not None:
            return _thin_attention(tile.element_id, content, *level_colors)
        return _recolor_palette(path, content)
    except (OSError, ValueError, SyntaxError) as error:
        raise UnexpectedShapeError(f"jma tile is not an image: {path}") from error


def _thin_attention(element_id: str, content: bytes, known: frozenset[RGB], attention: frozenset[RGB]) -> bytes:
    """注意の段の色の画素の不透明度を`_ATTENTION_ALPHA`へ下げる。パレット形式はパレットの透明度だけを、
    RGBA は画素の不透明度を替える。注意の段の画素が無ければ、そのまま返す。"""
    with Image.open(io.BytesIO(content)) as image:
        colors = cast(
            "list[tuple[int, tuple[int, int, int, int]]]", image.convert("RGBA").getcolors(maxcolors=1 << 16) or []
        )
        used = {rgba[:3] for _count, rgba in colors if rgba[3] > 0}
        for rgb in used - known:
            if (element_id, rgb) not in _warned_unknown:
                _warned_unknown.add((element_id, rgb))
                logger.warning(
                    "jma tile has a color missing from the level table: element=%s rgb=%s（weather_display.py の tile_color）",
                    element_id,
                    rgb,
                )
        if not used & attention:
            return content
        buffer = io.BytesIO()
        if image.mode == "P":
            palette = image.getpalette() or []
            entries = [tuple(palette[i : i + 3]) for i in range(0, len(palette), 3)]
            alphas = _palette_alphas(image.info.get("transparency"), len(entries))
            for index, entry in enumerate(entries):
                if entry in attention:
                    alphas[index] = min(alphas[index], _ATTENTION_ALPHA)
            image.save(buffer, format="PNG", transparency=bytes(alphas))
        else:
            pixels = np.array(image.convert("RGBA"))
            thin = np.zeros(pixels.shape[:2], dtype=np.bool_)
            for color in attention:
                thin |= np.all(pixels[..., :3] == np.array(color, dtype=pixels.dtype), axis=-1)
            pixels[..., 3] = np.where(thin, np.minimum(pixels[..., 3], _ATTENTION_ALPHA), pixels[..., 3])
            Image.fromarray(pixels).save(buffer, format="PNG")
    return buffer.getvalue()


def _recolor_palette(path: str, content: bytes) -> bytes:
    with Image.open(io.BytesIO(content)) as image:
        if image.mode != "P":
            return content
        # RGBAに直した画像の色は4つ組になる（`getcolors`の型は1帯の画像の数も含む）。
        colors = cast(
            "list[tuple[int, tuple[int, int, int, int]]]", image.convert("RGBA").getcolors(maxcolors=256) or []
        )
        unknown = {
            rgba[:3]
            for _count, rgba in colors
            if rgba[3] > 0 and rgba[:3] not in _PRECIPITATION_COLORS and rgba[:3] != _UNPAINTED
        }
        if unknown:
            raise UnexpectedShapeError(
                f"jma precipitation tile has colors missing from JMA_PRECIPITATION_TILE_COLORS: path={path} "
                f"rgb={sorted(unknown)}（jma_tile_recolor.py）"
            )
        palette = image.getpalette() or []
        entries = [tuple(palette[i : i + 3]) for i in range(0, len(palette), 3)]
        alphas = _palette_alphas(image.info.get("transparency"), len(entries))
        for index, entry in enumerate(entries):
            if entry == _UNPAINTED:
                alphas[index] = 0
        image.putpalette([value for entry in entries for value in _PRECIPITATION_COLORS.get(entry, entry)])
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", transparency=bytes(alphas))
    return buffer.getvalue()


def _palette_alphas(transparency: object, count: int) -> list[int]:
    """パレットの項目ごとの不透明度。PNGの透明度はパレットの頭から一部の項目だけを持つ（バイト列）か、
    透明な項目の番号1つで来る。持たない項目は不透明。"""
    alphas = [255] * count
    if isinstance(transparency, bytes):
        alphas[: len(transparency)] = transparency[:count]
    elif isinstance(transparency, int) and transparency < count:
        alphas[transparency] = 0
    return alphas
