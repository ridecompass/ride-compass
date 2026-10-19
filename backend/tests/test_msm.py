"""`domain/msm.py`——MSM格子の幾何（範囲と形状から導く格子・切り出す窓・格子点の並び）と、格子点の値の取り出し・
双一次補間・風の成分から風速と風向。

入口は`MsmGrid.from_bbox_and_shape`・`MsmGrid.window`と、窓の`lat_slice`/`lon_slice`で切り出した
部分ブロックを渡す`MsmWindow.interpolate`、格子点の並びを作る`MsmGrid.block_covering`・`MsmGrid.nearest_points`と
その`points_of`・`holds_nearest`・`values`、`wind_speed_and_direction`。格子はMSMの公表値（緯度0.05度・
経度0.0625度、北緯22.4〜47.6度・東経120〜150度）で作る。

ここで見ないもの:
- 配信元の同期・メタ情報（範囲の読み取りを含む）と実データの読み出し → `test_msm_client.py`
- 格子点の風をタイルの道・ルートの区間へ配ること → `test_wind_way_service.py`・`test_leg_costs.py`
"""

import math

import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.domain.msm import MsmGrid, wind_speed_and_direction

MSM_BBOX = (22.4, 120.0, 47.6, 150.0)
GRID = MsmGrid.from_bbox_and_shape(MSM_BBOX, 505, 481)

_LATITUDES = GRID.lat_min + GRID.d_lat * np.arange(GRID.n_lat)
_LONGITUDES = GRID.lon_min + GRID.d_lon * np.arange(GRID.n_lon)


def _bilinear(lat, lon):
    """双一次補間がそのまま再現する形（緯度・経度・その積の一次式）。時刻ごとに係数を変える。"""
    return np.stack([1.5 + 0.2 * lat - 0.1 * lon + 0.003 * lat * lon, -4.0 + 0.05 * lon - 0.002 * lat * lon], axis=-1)


FIELD = _bilinear(_LATITUDES[:, None], _LONGITUDES[None, :])


def test_the_published_msm_spacing_follows_from_the_bbox_and_the_shape():
    assert (GRID.d_lat, GRID.d_lon) == (pytest.approx(0.05), pytest.approx(0.0625))


@pytest.mark.parametrize(("n_lat", "n_lon"), [(1, 481), (505, 1)])
def test_a_grid_with_fewer_than_two_points_on_a_side_is_refused(n_lat, n_lon):
    with pytest.raises(ValueError):
        MsmGrid.from_bbox_and_shape(MSM_BBOX, n_lat, n_lon)


def _interpolate(latitudes, longitudes, field=FIELD):
    window = GRID.window(np.asarray(latitudes, dtype=float), np.asarray(longitudes, dtype=float))
    return window, window.interpolate(field[window.lat_slice, window.lon_slice])


_points = st.lists(
    st.tuples(
        st.floats(min_value=MSM_BBOX[0], max_value=MSM_BBOX[2]),
        st.floats(min_value=MSM_BBOX[1], max_value=MSM_BBOX[3]),
    ),
    min_size=1,
    max_size=5,
)


def _nearby_points():
    """ルート1本ぶんのように、格子数マスの中に集まった地点。"""
    return st.tuples(
        st.floats(min_value=MSM_BBOX[0], max_value=MSM_BBOX[2] - 0.3),
        st.floats(min_value=MSM_BBOX[1], max_value=MSM_BBOX[3] - 0.3),
    ).flatmap(
        lambda corner: st.lists(
            st.tuples(
                st.floats(min_value=corner[0], max_value=corner[0] + 0.3),
                st.floats(min_value=corner[1], max_value=corner[1] + 0.3),
            ),
            min_size=1,
            max_size=5,
        )
    )


@given(points=st.one_of(_points, _nearby_points()))
def test_interpolation_reproduces_a_bilinear_field_at_every_point_of_the_grid(points):
    latitudes, longitudes = (np.array(values) for values in zip(*points, strict=True))

    window, values = _interpolate(latitudes, longitudes)

    assert values.shape == (len(points), 2)
    np.testing.assert_allclose(values, _bilinear(latitudes, longitudes), rtol=1e-9, atol=1e-7)
    # 読む部分ブロックは地点の範囲より上下左右に1格子までしか広げない。
    assert window.i1 - window.i0 <= math.ceil((latitudes.max() - latitudes.min()) / GRID.d_lat) + 2
    assert window.j1 - window.j0 <= math.ceil((longitudes.max() - longitudes.min()) / GRID.d_lon) + 2


def test_grid_points_on_the_outer_edges_and_corners_return_the_grid_value():
    """全体格子の上端・右端ちょうどでは、その外側の格子点が無い。"""
    rng = np.random.default_rng(0)
    field = rng.normal(size=(GRID.n_lat, GRID.n_lon, 1))
    rows = [0, GRID.n_lat - 1, GRID.n_lat - 1, 0, GRID.n_lat - 1, 250]
    cols = [0, GRID.n_lon - 1, 0, GRID.n_lon - 1, 240, GRID.n_lon - 1]

    _, values = _interpolate(_LATITUDES[rows], _LONGITUDES[cols], field)

    np.testing.assert_allclose(values[:, 0], field[rows, cols, 0], rtol=1e-9)


@pytest.mark.parametrize(
    ("latitude", "longitude"),
    [(22.39, 135.0), (47.61, 135.0), (35.0, 119.99), (35.0, 150.01)],
    ids=["south", "north", "west", "east"],
)
def test_a_point_outside_the_grid_is_refused(latitude, longitude):
    with pytest.raises(ValueError):
        GRID.window(np.array([35.0, latitude]), np.array([135.0, longitude]))


# --- 格子点の値 ---

#: 格子の外周から0.3度より内側の地点（矩形をその周りに広げても格子に収まる）。
_INNER_LATITUDES = st.floats(min_value=MSM_BBOX[0] + 0.3, max_value=MSM_BBOX[2] - 0.3)
_INNER_LONGITUDES = st.floats(min_value=MSM_BBOX[1] + 0.3, max_value=MSM_BBOX[3] - 0.3)
_MARGINS = st.floats(min_value=0.0, max_value=0.3)


def _assert_on_the_grid(latitudes, longitudes):
    """座標がMSMの格子点そのもの（原点から刻みの整数倍）であること。"""
    rows = (latitudes - GRID.lat_min) / GRID.d_lat
    cols = (longitudes - GRID.lon_min) / GRID.d_lon
    np.testing.assert_allclose(rows, np.rint(rows), atol=1e-9)
    np.testing.assert_allclose(cols, np.rint(cols), atol=1e-9)


@given(_INNER_LATITUDES, _INNER_LONGITUDES, st.tuples(*[_MARGINS] * 8))
def test_a_place_picks_the_same_nearest_grid_point_from_any_rectangle_around_it(lat, lon, margins):
    """地図のタイルとルートは別の矩形から格子点の並びを作る。同じ地点が違う格子点を引くと、地図の色とルートの区間の風が
    食い違い、「最寄りの格子点の値」と示した値が最寄りの格子点の値でなくなる。"""
    picked = []
    for s, w, n, e in (margins[:4], margins[4:]):
        block = GRID.block_covering(lat - s, lon - w, lat + n, lon + e)
        point = block.points_of(np.array([lat]), np.array([lon]))
        latitudes, longitudes = block.coordinates()
        _assert_on_the_grid(latitudes, longitudes)
        assert block.holds_nearest(np.array([lat]), np.array([lon])).tolist() == [True]
        picked.append((float(latitudes[point][0]), float(longitudes[point][0])))

    assert picked[0] == pytest.approx(picked[1], abs=1e-9)
    assert abs(picked[0][0] - lat) <= GRID.d_lat / 2 + 1e-9
    assert abs(picked[0][1] - lon) <= GRID.d_lon / 2 + 1e-9


def test_a_place_outside_the_block_is_moved_to_its_edge_and_is_not_its_nearest_point():
    """タイルをまたぐ道の中ほどは並びの外にありうる。端の格子点は計算には使えるが、最寄りの格子点の値としては示せない。"""
    block = GRID.block_covering(35.0, 139.0, 35.05, 139.0625)
    lat, lon = block.coordinates()
    beyond = np.array([lat.min() - 1.0, lat.max() + 1.0]), np.array([lon.min() - 1.0, lon.max() + 1.0])

    assert block.points_of(*beyond).tolist() == [0, block.size - 1]
    assert block.holds_nearest(*beyond).tolist() == [False, False]


@given(points=st.one_of(_points, _nearby_points()))
def test_each_place_reads_the_value_of_its_nearest_grid_point_unchanged(points):
    """補間した値を地点の値として示すと予報業務の許可が要る。読む値は最寄りの格子点の値そのもの。"""
    latitudes, longitudes = (np.array(values) for values in zip(*points, strict=True))
    field = np.random.default_rng(0).normal(size=(GRID.n_lat, GRID.n_lon, 2))

    selected = GRID.nearest_points(latitudes, longitudes)
    rows = np.rint((latitudes - GRID.lat_min) / GRID.d_lat).astype(int)
    cols = np.rint((longitudes - GRID.lon_min) / GRID.d_lon).astype(int)

    np.testing.assert_array_equal(selected.values(field[selected.lat_slice, selected.lon_slice]), field[rows, cols])
    point_latitudes, point_longitudes = selected.coordinates()
    assert np.all(np.abs(point_latitudes - latitudes) <= GRID.d_lat / 2 + 1e-9)
    assert np.all(np.abs(point_longitudes - longitudes) <= GRID.d_lon / 2 + 1e-9)


@pytest.mark.parametrize(
    "corners",
    [(22.39, 135.0, 35.0, 136.0), (35.0, 135.0, 47.61, 136.0), (35.0, 119.99, 36.0, 136.0), (35.0, 135.0, 36.0, 150.01)],
    ids=["south", "north", "west", "east"],
)
def test_a_rectangle_reaching_outside_the_grid_is_refused(corners):
    with pytest.raises(ValueError):
        GRID.block_covering(*corners)


@given(
    speed=st.floats(min_value=0.1, max_value=60),
    direction=st.floats(min_value=0, max_value=360, exclude_max=True),
)
def test_speed_and_the_direction_the_wind_comes_from_are_recovered_from_the_components(speed, direction):
    """北から吹く風（向かう先は南）は南北成分が負。風向は吹いてくる方位で北=0・東=90。"""
    u = np.array([-speed * math.sin(math.radians(direction))])
    v = np.array([-speed * math.cos(math.radians(direction))])

    speeds, directions = wind_speed_and_direction(u, v)

    assert speeds[0] == pytest.approx(speed)
    difference = (directions[0] - direction + 180) % 360 - 180
    assert abs(difference) < 1e-6
