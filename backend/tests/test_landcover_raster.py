"""`infrastructure/landcover_raster.py`——土地被覆のGeoTIFFから、XYZタイル1枚ぶんのクラスと絵を作る。

入口は`tile_classes`・`render_tile`・`empty_tile_png`。
ラスタは置き場（フィクスチャ`raster_dir`）に本物のGeoTIFFを書く。開いたラスタはプロセスに残るので、テストごとに閉じる口（`close_sources`）で開く前の状態に戻してから始め、同じ口で閉じる。
タイルの範囲はXYZの公開の定義（Web Mercatorの全幅を2^z等分し、yは北から数える）から作る。

ここで見ないもの:
- 配色の中身（どのクラスを塗り、何色か） → `domain/landcover.py: LANDCOVER_CLASSES`の宣言。
  ここではクラスを「塗る」「塗らない」の性質で選び、色は宣言から読む
- 空のタイルを返すこと・キャッシュの鍵 → `test_landcover_tile.py`
- 取込がタイルのクラスをDBへ入れること → 取込のアダプタ（`batch/source_adapters/io_lulc_tile.py`）の持ち物
"""

import io
import math
import os

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.transform import from_origin
from rasterio.warp import transform as transform_points

from app.infrastructure import landcover_raster

HALF_WORLD_M = 20037508.342789244
TOKYO = (14, 14552, 6451)
SIZE = landcover_raster.TILE_SIZE


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    size = 2 * HALF_WORLD_M / 2**z
    west = -HALF_WORLD_M + x * size
    north = HALF_WORLD_M - y * size
    return west, north - size, west + size, north


def tile_center_lonlat(z: int, x: int, y: int) -> tuple[float, float]:
    n = 2**z
    lon = (x + 0.5) / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 0.5) / n))))
    return lon, lat


def write_raster(path, classes: np.ndarray, crs: str, west: float, north: float, pixel_m: float) -> str:
    height, width = classes.shape
    with rasterio.open(
        path, "w", driver="GTiff", width=width, height=height, count=1, dtype="uint8", crs=crs,
        transform=from_origin(west, north, pixel_m, pixel_m), compress="deflate",
    ) as dataset:
        dataset.write(classes.astype(np.uint8), 1)
    return str(path)


def over_tile(path, classes: np.ndarray, z: int, x: int, y: int) -> str:
    """タイルの範囲をちょうど覆うWeb Mercatorのラスタ（1画素がタイルの1画素に揃う大きさなら、画素がそのまま写る）。"""
    west, _, east, north = tile_bounds(z, x, y)
    return write_raster(path, classes, "EPSG:3857", west, north, (east - west) / classes.shape[1])


@pytest.fixture
def raster_store(raster_dir):
    """空の置き場の、ラスタをまだ開いていない状態から始める。"""
    landcover_raster.close_sources()
    yield raster_dir
    landcover_raster.close_sources()


def stripes(*values: int, size: int = SIZE) -> np.ndarray:
    """西から東へ、等しい幅の縦縞に値を並べる。"""
    columns = np.array_split(np.arange(size), len(values))
    out = np.zeros((size, size), dtype=np.uint8)
    for value, cols in zip(values, columns, strict=True):
        out[:, cols] = value
    return out


def decoded(png: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(png)) as image:
        assert image.mode == "RGBA"
        return np.asarray(image)


def test_reprojecting_a_utm_raster_keeps_class_numbers_and_invents_none(raster_store):
    """画素値はクラス番号なので、隣り合う2クラスの間に別のクラスが生まれてはいけない。"""
    lon, lat = tile_center_lonlat(*TOKYO)
    (easting,), (northing,) = transform_points("EPSG:4326", "EPSG:32654", [lon], [lat])
    half_m = 3000
    write_raster(raster_store / "54S.tif", stripes(5, 7, size=600), "EPSG:32654",
                 easting - half_m, northing + half_m, 10)

    classes = landcover_raster.tile_classes(landcover_raster.open_rasters(), *TOKYO)

    # タイルはラスタの内側にあるので、縁まで全画素がクラスを持つ。
    assert set(np.unique(classes)) == {5, 7}


def test_where_rasters_overlap_the_first_by_name_wins_and_the_next_fills_its_gaps(raster_store):
    """値0（範囲外・No Data）は、先のラスタが描いた画素を消さず、後のラスタに埋めさせる。"""
    over_tile(raster_store / "53S_2024.tif", stripes(2, 0), *TOKYO)
    over_tile(raster_store / "54S_2024.tif", stripes(5), *TOKYO)

    classes = landcover_raster.tile_classes(landcover_raster.open_rasters(), *TOKYO)

    assert (classes[:, : SIZE // 2] == 2).all()
    assert (classes[:, SIZE // 2 :] == 5).all()


def test_a_raster_finer_than_the_read_limit_still_fills_the_whole_tile(raster_store):
    """低いズームでは間引いて読む。間引いた分の画素の大きさを合わせないと、タイルの一部しか埋まらない。"""
    z, x, y = 12, TOKYO[1] // 4, TOKYO[2] // 4
    over_tile(raster_store / "fine.tif", stripes(2, 5, size=2048), z, x, y)

    classes = landcover_raster.tile_classes(landcover_raster.open_rasters(), z, x, y)

    assert (classes[:, : SIZE // 2] == 2).all()
    assert (classes[:, SIZE // 2 :] == 5).all()


def test_the_image_paints_painted_classes_in_their_colour_and_leaves_the_rest_clear(raster_store):
    classes = landcover_raster.LANDCOVER_CLASSES
    painted = [c for c in classes if c.painted]
    unpainted = [c for c in classes if not c.painted]
    assert painted, "塗るクラスが1つも無い"
    assert unpainted, "塗らないクラスが1つも無い"
    unknown = next(v for v in range(1, 256) if v not in {c.value for c in classes})
    over_tile(raster_store / "a.tif", stripes(painted[0].value, unpainted[0].value, unknown), *TOKYO)

    image = decoded(landcover_raster.render_tile(landcover_raster.open_rasters(), *TOKYO))

    hex_colour = painted[0].color.lstrip("#")
    assert tuple(image[SIZE // 2, 10]) == (*bytes.fromhex(hex_colour), 255)
    assert image[SIZE // 2, SIZE // 2, 3] == 0
    assert image[SIZE // 2, SIZE - 10, 3] == 0


def test_the_empty_tile_is_a_fully_clear_image_of_tile_size():
    image = decoded(landcover_raster.empty_tile_png())

    assert image.shape == (SIZE, SIZE, 4)
    assert (image[:, :, 3] == 0).all()


def test_the_rasters_are_reopened_whenever_the_store_changes(raster_store):
    """取得が置き場のラスタを替えたら、次の読みで開き直して新しいものを描く（前に開いたものを描き続けると、
    年が替わっても前の年の絵が出る）。前のものの更新時刻は先週へ戻す（同じ時刻の刻みの中で置き換えると、時刻に出ない）。
    同じ名前での置き換えは、更新時刻だけを進めて表す（Windowsは開いたファイルを置き換えも消しもできない）。"""
    previous = over_tile(raster_store / "54S_2024.tif", stripes(2), *TOKYO)
    os.utime(previous, (0, 0))
    opened = landcover_raster.open_rasters()
    assert landcover_raster.tile_classes(opened, *TOKYO)[0, 0] == 2

    os.utime(previous)
    replaced = landcover_raster.open_rasters()
    assert replaced is not opened
    assert landcover_raster.open_rasters() is replaced

    over_tile(raster_store / "53S_2024.tif", stripes(5), *TOKYO)
    assert landcover_raster.tile_classes(landcover_raster.open_rasters(), *TOKYO)[0, 0] == 5
