"""気象庁の推計気象分布（天気）の、地点の天気の区分を取る。

推計気象分布（天気）は、ひまわりの雲の観測・解析雨量・推計気象分布（気温）から約1km四方ごとに天気を決めた
実況で、配信元は天気の区分ごとに決まった色で塗ったタイルを配る。区分と色は公式の画面
（`bosai/suikei/`）の設定ファイル`table/suikei.properties__<hash>.xml`の要素`wthr`と、その凡例
`images/legend_jp_normal_wm.svg`から写す。

地図に重ねる気象庁タイル（`domain/jma_tile_specs.py: JMA_ELEMENTS`）とは別に持つ——このタイルは512画素で、
パスのズームが`z`のとき`x`・`y`は1辺`2**(z-1)`枚の並びで数える（256画素の`JMA_ELEMENTS`のタイルとは
同じズームでも座標が合わない）。

時刻一覧とタイルは`JmaTileClient`を通し、そのキャッシュに乗る。タイル1枚は経度0.7度ぶん
（約60km）四方を覆い、近くの利用者で共有される。
"""

import io
from typing import NamedTuple, cast

from PIL import Image

from app.domain.jma_tile_specs import JMA_DATA_ROOT, JmaFrame, read_target_times
from app.domain.region import tile_position
from app.domain.weather import SuikeiWeather
from app.infrastructure.jma_tile_client import JmaTileClient, get_target_times
from app.infrastructure.http_client import UpstreamNotFound
from app.infrastructure.simple_api_client import UnexpectedShapeError

#: 時刻一覧に載る天気の要素id。
_WEATHER_ELEMENT = "wthr"
_ROOT = f"{JMA_DATA_ROOT}/suikeikishou"
_TARGET_TIMES_PATH = f"{_ROOT}/targetTimes.json"
# 設定ファイルの`maxNativeZoom`（画像が実在する最大ズーム）。`zoomUse="even"`とも合う。
_ZOOM = 10
_TILE_SIZE = 512
_CATEGORY = "weather:jma-suikei"

_WEATHER_BY_COLOR: dict[tuple[int, int, int], SuikeiWeather] = {
    (255, 170, 0): "clear",
    (170, 170, 170): "cloudy",
    (0, 65, 255): "rain",
    (160, 210, 255): "rain_or_snow",
    (242, 242, 255): "snow",
}


class _Pixel(NamedTuple):
    """地点を含むタイルと、その中の画素。"""

    x: int
    y: int
    column: int
    row: int


def _pixel(latitude: float, longitude: float) -> _Pixel:
    """地点を含む天気のタイルと画素（Webメルカトル）。"""
    tile_x, tile_y = tile_position(longitude, latitude, _ZOOM - 1)
    x = int(tile_x * _TILE_SIZE)
    y = int(tile_y * _TILE_SIZE)
    return _Pixel(x // _TILE_SIZE, y // _TILE_SIZE, x % _TILE_SIZE, y % _TILE_SIZE)


def _tile_path(frame: JmaFrame, pixel: _Pixel) -> str:
    """天気のタイルの、配信元のパス。"""
    return (
        f"{_ROOT}/{frame.basetime}/{frame.member}/{frame.validtime}/surf/{_WEATHER_ELEMENT}"
        f"/{_ZOOM}/{pixel.x}/{pixel.y}.png"
    )


def _weather_from_color(red: int, green: int, blue: int, alpha: int) -> SuikeiWeather | None:
    """画素の色を天気の区分へ。透明（推計の範囲の外・欠測）はNone。凡例に無い色なら投げる（配信元が配色を変えた印）。"""
    if alpha == 0:
        return None
    weather = _WEATHER_BY_COLOR.get((red, green, blue))
    if weather is None:
        raise UnexpectedShapeError(
            f"jma suikei weather color missing from _WEATHER_BY_COLOR: rgb={(red, green, blue)}（jma_suikei_client.py）"
        )
    return weather


async def fetch_weather(client: JmaTileClient, latitude: float, longitude: float) -> SuikeiWeather | None:
    """最新の天気のタイルの、地点の天気の区分。タイルが無い・透明ならNone。読めなければ投げる。"""
    frames = read_target_times("latest", await get_target_times(client, _TARGET_TIMES_PATH), _WEATHER_ELEMENT)
    if not frames:
        raise UnexpectedShapeError(f"jma suikei target times have no frame: {_TARGET_TIMES_PATH}")
    pixel = _pixel(latitude, longitude)
    path = _tile_path(frames[0], pixel)
    raw = await client.get(path)
    if isinstance(raw, UpstreamNotFound):
        return None
    content, _content_type = raw
    try:
        with Image.open(io.BytesIO(content)) as image:
            # 1画素だけを切り出してから揃える（パレットと透過の指定は切り出しても残る）。
            only = image.crop((pixel.column, pixel.row, pixel.column + 1, pixel.row + 1)).convert("RGBA")
            red, green, blue, alpha = cast(tuple[int, int, int, int], only.getpixel((0, 0)))
    except (OSError, ValueError, SyntaxError) as error:
        raise UnexpectedShapeError(f"jma suikei weather tile is not an image: {path}") from error
    return _weather_from_color(red, green, blue, alpha)
