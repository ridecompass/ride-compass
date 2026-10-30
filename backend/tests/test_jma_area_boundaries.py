"""`infrastructure/jma_area_boundaries.py`——置き場の区域の境界から、地点が属する区域（area.jsonのclass20）のコードを引く。

入口は`find_class20_code`と、引いた区域を地域マスタで警報のエリアまで辿る`resolve_point_area`で、境界は`write_boundaries`で置き場（`tests/conftest.py: boundary_path`）に書いたものを
本物の読み込みで読む。区域は架空のコードと矩形で作る。見るのは、境界を読めないとき（区域なしとは別の例外と
WARNING）と、置いたあとは再起動せずに引けること。地点から区域を引く規則（含む区域・寄せる距離の内側の最寄りの区域・
どこにも入らない地点のNone）は、境界を直接与えた`AreaBoundaries.find_many`（1地点の`find`はこれへ委ねる）の性質で見る。`resolve_point_area`は、区域の外と
区域が分からない（境界を読めない・地域マスタを取れない・辿れない）を分けることと、辿れない区域の名前を出すことを見る。

ここで見ないもの:
- 配布元のシェープファイルから境界を作る・置き場の版の入れ替え → `test_fetch_jma_area_boundaries.py`
- 区域のコードから警報エリアを辿る → `test_jma_area.py`
- 区域の外・区域が分からないが警報・洪水予報の応答のどこへ出るか → `test_warning_service.py`・`test_flood_service.py`
"""

import logging

import pytest
import shapely
from hypothesis import assume, example, given
from hypothesis import strategies as st
from shapely.geometry import box

from app.domain.jma_area import NEAREST_LIMIT_DEG, ResolvedArea
from app.infrastructure import jma_area_boundaries
from app.infrastructure.jma_area_boundaries import OUTSIDE_AREAS
from app.infrastructure.jma_warning_client import new_area_data_cache
from tests.fake_http import client_for
from tests.jma_area_fixtures import (
    CHIYODA_POINT,
    CLASS10_CODE,
    CLASS20_CODE,
    OFFICE_CODE,
    OFFSHORE_POINT,
    area_lookup_upstream,
)

LIMIT = NEAREST_LIMIT_DEG

#: 経度方向に長い矩形（緯度35.6〜35.7・経度139.6〜139.9）を東西に分けた区域。緯度と経度を取り違えると外れる。
WEST = box(139.6, 35.6, 139.75, 35.7)
#: 寄せる距離と同じ程度の大きさの区域を、寄せる距離ちょうどの隙間で並べた架空の区域。区域の中・隙間・
#: 寄せる距離の内外が、どれも乱数で十分に引かれる大きさにする。経度方向に長いので、緯度と経度を取り違えると外れる。
_SMALL_AREAS = {
    "0000110": box(139.0, 35.0, 139.0 + 2 * LIMIT, 35.0 + LIMIT),
    "0000120": box(139.0 + 3 * LIMIT, 35.0, 139.0 + 5 * LIMIT, 35.0 + LIMIT),
}


_LATITUDES = st.floats(min_value=35.0 - 2 * LIMIT, max_value=35.0 + 3 * LIMIT)
_LONGITUDES = st.floats(min_value=139.0 - 2 * LIMIT, max_value=139.0 + 7 * LIMIT)


@given(points=st.lists(st.tuples(_LATITUDES, _LONGITUDES), min_size=1, max_size=6))
# 区域の中の地点のあとに、区域の間の隙間の地点が続く並び（測り直した答えを並びへ戻す所を取り違えると、後の地点がNoneになる）。
@example(points=[(35.0 + LIMIT / 2, 139.0 + LIMIT), (35.0 + LIMIT / 2, 139.0 + 2.5 * LIMIT)])
def test_each_point_gets_the_nearest_area_within_the_limit(points):
    """地点ごとに、含む区域があればそれ、無ければ寄せる距離の内側で最も近い区域、どれも遠ければNone。まとめて引いても
    答えは地点の並びのまま（含まれない地点だけを測り直すので、並びを取り違えると隣の地点の答えになる）。
    全区域との距離を測った答えと比べる。"""
    found = jma_area_boundaries.AreaBoundaries(list(_SMALL_AREAS), list(_SMALL_AREAS.values())).find_many(points)

    assert len(found) == len(points)
    for (lat, lon), code in zip(points, found, strict=True):
        point = shapely.Point(lon, lat)
        distances = {area: geometry.distance(point) for area, geometry in _SMALL_AREAS.items()}
        nearest = min(distances.values())
        assume(abs(nearest - LIMIT) > 1e-12)
        if nearest > LIMIT:
            assert code is None
        else:
            assert code is not None
            assert distances[code] <= nearest + 1e-12


async def test_missing_boundaries_raise_and_warn_until_they_are_written(boundary_path, caplog):
    """置き場に無ければ、区域なし（None）ではなく読めない例外とWARNING。置いたあとは再起動せずに引ける。"""
    with caplog.at_level(logging.WARNING, logger="ridecompass.external"):
        with pytest.raises(jma_area_boundaries.AreaBoundariesUnavailableError):
            await jma_area_boundaries.find_class20_code(35.65, 139.7)
    assert [record.levelno for record in caplog.records] == [logging.WARNING]

    jma_area_boundaries.write_boundaries(boundary_path, {"0000010": WEST})

    assert await jma_area_boundaries.find_class20_code(35.65, 139.7) == "0000010"


@pytest.mark.parametrize(
    ("point", "upstream", "unreadable", "expected"),
    [
        (CHIYODA_POINT, {}, False, ResolvedArea(CLASS20_CODE, CLASS10_CODE, OFFICE_CODE)),
        (OFFSHORE_POINT, {}, False, OUTSIDE_AREAS),
        (CHIYODA_POINT, {}, True, None),
        (CHIYODA_POINT, {"area_data": None}, False, None),
        # 境界が返した区域を地域マスタで辿れない
        (CHIYODA_POINT, {"class20_code": "9999900"}, False, None),
    ],
    ids=["resolved", "outside", "boundaries_unreadable", "master_unavailable", "master_cannot_follow"],
)
async def test_a_point_resolves_to_its_warning_area_or_says_it_is_unknown(
    boundary_path, point, upstream, unreadable, expected
):
    """区域が分からない（None）を区域の外（`OUTSIDE_AREAS`）と同じに扱うと、警報・洪水予報が出ていないと見せる。"""
    client = client_for(area_lookup_upstream(boundary_path, **upstream))
    if unreadable:
        boundary_path.unlink()

    resolved = await jma_area_boundaries.resolve_point_area(
        client, new_area_data_cache(), point.latitude, point.longitude
    )

    assert resolved == expected


async def test_a_point_the_master_cannot_follow_names_its_area(boundary_path, caplog):
    """区域の境界と地域マスタは別々に配られ、片方だけが区域の変更に追いつくと起きる。運用者が気づけるように出す。"""
    client = client_for(area_lookup_upstream(boundary_path, class20_code="9999900"))

    with caplog.at_level(logging.WARNING, logger="ridecompass.external"):
        await jma_area_boundaries.resolve_point_area(
            client, new_area_data_cache(), CHIYODA_POINT.latitude, CHIYODA_POINT.longitude
        )

    assert any("9999900" in record.getMessage() for record in caplog.records)
