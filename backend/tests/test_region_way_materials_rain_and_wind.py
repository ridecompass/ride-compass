"""雨と風の材料を合わせて読む軸の地図の値（`GET /api/region/way-materials`）を、本物の注入（`api/dependencies.py:
get_dedicated_way_value_service`）と、取込と道路網の導出を通して置いた道で引く。

雨と風の材料のサービスは、どちらも道の中ほどの点を読む。読み出しは材料に依らないので、1つの要求の中ではタイルにつき
1回だけDBへ問い合わせる。回数は、アプリのセッション工場がテストDBへ送る文のうち中ほどの点の問い合わせを数えて見る
（回数そのものが、この口の所要時間の約束）。差し替えるのは注入される気象サービスだけで、雨量計ごとの今の雨と、
どの格子点も無風の予報を返す。無風なら風の抵抗の比は0なので、軸の値は雨の値だけで決まる。

ここで見ないもの:
- 雨の材料の値の出し方（最寄りの雨量計） → `test_rain_way_service.py`、風の格子点の選び方 → `test_wind_way_service.py`
- 軸の葉の材料から配るサービスを選ぶこと・応答の形 → `test_region_routes.py`
"""

from datetime import datetime, timedelta

import httpx
import numpy as np
import pytest
from sqlalchemy import event

from app.api.dependencies import get_weather_service
from app.batch import derive_topology
from app.domain.axis_definitions import AxisDefinition, BreakpointLinearShape, MaterialTerm
from app.domain.material_catalog import WIND_DRAG_RATIO
from app.domain.rain import StationRainMaterials, rain_window_material_id
from app.domain.region import BoundingBox, EDGE_UNIT_MIN_ZOOM, tile_bounds_lonlat
from app.domain.wind import WindForecastSeries
from app.infrastructure import database
from app.main import app
from app.services.weather_service import WeatherService
from tests.axis_system_fixture import replaced_axis_definitions
from tests.bound_fake import bound
from tests.conftest import raw_connection
from tests.msm_grid import MSM_GRID
from tests.source_ingest import ingest_records, way_record

pytestmark = pytest.mark.asyncio(loop_scope="module")

RAIN_1H = rain_window_material_id(1)

#: 雨（1時間）と風の抵抗の比を足して得点へ写す軸。
RAIN_AND_WIND_AXIS = AxisDefinition(
    axis_id="axis_rain_and_wind",
    shape=BreakpointLinearShape(
        terms=[MaterialTerm(material=RAIN_1H), MaterialTerm(material=WIND_DRAG_RATIO)],
        breakpoints=[(0.0, 0.0), (10.0, 100.0)],
    ),
    default_weight=0.2,
    label="雨と風",
    is_published=True,
)

TILE = (EDGE_UNIT_MIN_ZOOM, 14551, 6447)
BOUNDS = tile_bounds_lonlat(*TILE)
MIDDLE_LAT = (BOUNDS.min_latitude + BOUNDS.max_latitude) / 2
#: タイルの西と東の外の雨量計（緯度, 経度）と、そこの1時間の雨（mm）。タイルの西寄りの道は西の、東寄りの道は東の雨量計に近い。
GAUGES = {(MIDDLE_LAT, BOUNDS.min_longitude - 0.02): 2.0, (MIDDLE_LAT, BOUNDS.max_longitude + 0.02): 5.0}
AT = datetime(2026, 8, 30, 9, 0)


async def _station_rain_materials(self, now):
    latitudes, longitudes = zip(*GAUGES)
    return StationRainMaterials(
        latest_hour=now.replace(minute=0, second=0, microsecond=0),
        latitudes=np.array(latitudes), longitudes=np.array(longitudes),
        values={RAIN_1H: np.array(list(GAUGES.values()))},
    )


async def _calm_wind_forecast_lattice(self, bbox: BoundingBox):
    points = MSM_GRID.block_covering(bbox.min_latitude, bbox.min_longitude, bbox.max_latitude, bbox.max_longitude).all_points()
    times = [AT - timedelta(hours=1), AT, AT + timedelta(hours=1)]
    calm = np.zeros((len(points.coordinates()[0]), len(times)))
    return WindForecastSeries(times=times, speed_ms=calm, direction_deg=calm, lattice=points.block)


class GaugesAndCalmWeather:
    """雨量計ごとの今の雨と、どの格子点も無風の予報を返す気象サービスの代役。"""

    get_station_rain_materials = bound(WeatherService.get_station_rain_materials, _station_rain_materials)
    get_wind_forecast_lattice = bound(WeatherService.get_wind_forecast_lattice, _calm_wind_forecast_lattice)


@pytest.mark.usefixtures("app_on_test_database")
async def test_an_axis_reading_rain_and_wind_paints_each_road_by_its_gauge_reading_the_midpoints_once(
        override_dependency):
    west, east = BOUNDS.min_longitude, BOUNDS.max_longitude
    width = east - west
    await ingest_records("osm_way", [
        way_record(1, [(west + width * 0.1, MIDDLE_LAT), (west + width * 0.2, MIDDLE_LAT)], [1, 2]),
        way_record(2, [(west + width * 0.8, MIDDLE_LAT), (west + width * 0.9, MIDDLE_LAT)], [3, 4]),
    ], bbox=(BOUNDS.min_latitude, west, BOUNDS.max_latitude, east))
    async with raw_connection() as conn:
        await derive_topology.derive(conn)
    override_dependency(get_weather_service, GaugesAndCalmWeather)
    midpoint_reads = []

    def executed(conn, cursor, statement, *_):
        if "AS feature_midpoints" in statement:
            midpoint_reads.append(statement)

    engine = database.get_session_factory().kw["bind"].sync_engine
    event.listen(engine, "before_cursor_execute", executed)
    transport = httpx.ASGITransport(app=app)
    with replaced_axis_definitions({RAIN_AND_WIND_AXIS.axis_id: RAIN_AND_WIND_AXIS}):
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/api/region/way-materials/{RAIN_AND_WIND_AXIS.axis_id}/{TILE[0]}/{TILE[1]}/{TILE[2]}",
                params={"at": AT.isoformat(), "bearing_deg": 90.0, "speed_kmh": 20.0},
            )

    assert response.status_code == 200
    painted = {key: values["axis:value"] for key, values in response.json().items()}
    assert painted == {"1-0": pytest.approx(20.0), "2-0": pytest.approx(50.0)}
    assert len(midpoint_reads) == 1
