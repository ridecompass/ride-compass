"""地点の標高の引き方（`infrastructure/dem_elevation.py: fill_elevations`）。

点の標高が、まわりの4画素の双線形補間になることを、値を決めたタイルで見る。z15 の2×2枚のタイルに、上の製品は画素の
番地の1次式（平面）の値を置く——双線形補間は平面を正しく戻すので、点の位置での平面の値と一致すれば、タイルの中でも境を
またいでも4画素と重みが合っている。最寄りの1画素で引くと、画素の中心でない点は平面から外れる（平らでない道に段が出る）。

ここで見ないもの:
- 区間の断面の点の拾い方・製品の優先順を区間の値で見ること → `test_derive_elevation.py`
- 走った記録の地点の標高を GPX へ書くこと → `test_ride_track_routes.py`
"""

import asyncpg
import pytest
import pytest_asyncio

from app.domain.gsi_tiles import PRODUCT_PRIORITY
from app.domain.region import BoundingBox, tile_bounds_lonlat, tile_position
from app.infrastructure.dem_elevation import fill_elevations, products_in_priority
from tests.conftest import empty_ingested_tables
from tests.source_ingest import dem_tile_records, ingest_records

# moduleスコープのderive_conn（conftest.py）の上のDBを使うため、.claude/rules/testing-backend.mdのパターン2どおり
# loop_scope="module"が必須。
pytestmark = pytest.mark.asyncio(loop_scope="module")

#: 2×2枚のタイルの左上のタイル。画素の番地は、このタイルの左上の角からの画素の数で言う。
ZOOM, X, Y = 15, 29100, 12902
SIZE = 256
UPPER, LOWER = PRODUCT_PRIORITY[:2]

#: 上の製品が欠ける画素の範囲（左上の番地と、列・行の数）。1つ目は下の製品にも値があり、2つ目はどの製品にも無い。
UPPER_HOLE = (100, 100, 10)
NO_VALUE_HOLE = (300, 300, 10)
LOWER_VALUE = 500.0


def _plane(u: float, v: float) -> float:
    """上の製品の画素 (列 u, 行 v) の値。0.01m の刻みで詰めても丸まらない値にする。"""
    return 10.0 + 0.5 * u + 0.25 * v


def _in(hole, u: int, v: int) -> bool:
    u0, v0, n = hole
    return u0 <= u < u0 + n and v0 <= v < v0 + n


def _pixel(lon: float, lat: float) -> tuple[int, int]:
    """画素の中心の (経度, 緯度) から、その画素の番地。"""
    x, y = tile_position(lon, lat, ZOOM + 8)
    return int(x) - X * SIZE, int(y) - Y * SIZE


def _upper(lon: float, lat: float) -> float | None:
    u, v = _pixel(lon, lat)
    return None if _in(UPPER_HOLE, u, v) or _in(NO_VALUE_HOLE, u, v) else _plane(u, v)


def _lower(lon: float, lat: float) -> float | None:
    return None if _in(NO_VALUE_HOLE, *_pixel(lon, lat)) else LOWER_VALUE


def _point(u: float, v: float) -> tuple[float, float]:
    """左上のタイルの角から画素の数で (u, v) の位置（4分の1の画素の刻み）の (経度, 緯度)。z25 のタイルの角に当てて出す。"""
    b = tile_bounds_lonlat(ZOOM + 10, round((X * SIZE + u) * 4), round((Y * SIZE + v) * 4))
    return b.min_longitude, b.max_latitude


#: (点の位置, 採られるはずの標高)。値は画素の中心にあるので、位置 (u, v) は画素の中心の格子の (u − 0.5, v − 0.5) に当たる。
CASES = (
    ((20.5, 30.5), _plane(20, 30)),  # 画素の中心ちょうどは、その画素の値
    ((17.25, 40.75), _plane(16.75, 40.25)),  # タイルの中の4画素
    ((256.0, 50.25), _plane(255.5, 49.75)),  # 左右のタイルの境の上
    ((255.75, 255.75), _plane(255.25, 255.25)),  # 4枚のタイルの角のそば（4画素が4枚に分かれる）
    ((256.25, 300.75), _plane(255.75, 300.25)),  # 下の段の左右のタイルの境
    # 4画素のうち右下の1つだけが上の製品に無い——残る3画素で重みを付け直す（4画素の真ん中なので3つの平均）
    ((100.0, 100.0), (_plane(99, 99) + _plane(100, 99) + _plane(99, 100)) / 3),
    ((105.0, 105.0), LOWER_VALUE),  # 4画素とも上の製品に無い——下の製品の値
    ((305.0, 305.0), None),  # どの製品にも無い
)


@pytest_asyncio.fixture(loop_scope="module")
async def dem_conn(derive_conn):
    await empty_ingested_tables(derive_conn)
    west, south = tile_bounds_lonlat(ZOOM, X, Y + 1).min_longitude, tile_bounds_lonlat(ZOOM, X, Y + 1).min_latitude
    east, north = tile_bounds_lonlat(ZOOM, X + 1, Y).max_longitude, tile_bounds_lonlat(ZOOM, X + 1, Y).max_latitude
    inset = 1e-6
    area = BoundingBox(min_latitude=south + inset, min_longitude=west + inset,
                       max_latitude=north - inset, max_longitude=east - inset)
    await ingest_records("dem", [*dem_tile_records(UPPER, ZOOM, area, _upper),
                                 *dem_tile_records(LOWER, ZOOM, area, _lower)], conn=derive_conn)
    return derive_conn


async def _elevations(conn: asyncpg.Connection, points) -> list[float | None]:
    async with conn.transaction():
        await conn.execute("CREATE TEMP TABLE _point (vid bigint, lon float8, lat float8) ON COMMIT DROP")
        await conn.executemany("INSERT INTO _point VALUES ($1, $2, $3)",
                               [(i, *_point(u, v)) for i, (u, v) in enumerate(points)])
        await fill_elevations(conn, "_point", "_elev", await products_in_priority(conn))
        got = {r["vid"]: r["elev"] for r in await conn.fetch("SELECT vid, elev FROM _elev")}
    return [got.get(i) for i in range(len(points))]


async def test_a_point_takes_the_bilinear_value_of_the_four_pixels_around_it(dem_conn):
    got = await _elevations(dem_conn, [position for position, _ in CASES])
    assert got == [None if expected is None else pytest.approx(expected, abs=1e-6) for _, expected in CASES]


async def test_calling_it_again_in_one_transaction_reuses_the_tables_instead_of_piling_files_on_disk(dem_conn):
    """取引の中で消した表のファイルは取引の終わりまで残る——呼ぶたびに作り直すと、塊の数だけディスクに積もる。"""
    tables = ("_elev", "_dem_point_pixel")
    filenodes = "SELECT " + ", ".join(f"pg_relation_filenode('{t}')" for t in tables)
    (first, _), (second, second_value) = CASES[0], CASES[1]
    async with dem_conn.transaction():
        await dem_conn.execute("CREATE TEMP TABLE _point (vid bigint, lon float8, lat float8) ON COMMIT DROP")
        products = await products_in_priority(dem_conn)
        await dem_conn.execute("INSERT INTO _point VALUES (0, $1, $2)", *_point(*first))
        await fill_elevations(dem_conn, "_point", "_elev", products)
        before = await dem_conn.fetchrow(filenodes)
        await dem_conn.execute("TRUNCATE _point")
        await dem_conn.execute("INSERT INTO _point VALUES (1, $1, $2)", *_point(*second))
        await fill_elevations(dem_conn, "_point", "_elev", products)
        assert await dem_conn.fetchrow(filenodes) == before
        assert [tuple(r) for r in await dem_conn.fetch("SELECT vid, elev FROM _elev")] == [(1, pytest.approx(second_value, abs=1e-6))]
