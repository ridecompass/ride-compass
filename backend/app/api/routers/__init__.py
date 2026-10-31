"""全ルータを1つのapi_routerへ束ねる。

エンドポイントは関心ごとにモジュールへ分けてあり、どのモジュールがどのパスを持つかは下のinclude一覧と
各モジュールが正本（全パスはOpenAPIで引ける）。`/api/admin/...`はどれもHTTP Basic認証の内側に置く。
"""

from fastapi import APIRouter

from app.api.routers import (
    axis_admin,
    axis_catalog,
    basemap,
    db_status,
    debug_admin,
    derived_data_freshness,
    gsi_tile,
    health,
    jma_tile,
    material_catalog,
    place_search,
    region,
    road_class_admin,
    routes,
    tuning_admin,
    weather,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(routes.router)
api_router.include_router(weather.router)
api_router.include_router(place_search.router)
api_router.include_router(region.router)
api_router.include_router(basemap.router)
api_router.include_router(jma_tile.router)
api_router.include_router(gsi_tile.router)
api_router.include_router(axis_admin.router)
api_router.include_router(tuning_admin.router)
api_router.include_router(road_class_admin.router)
api_router.include_router(axis_catalog.router)
api_router.include_router(material_catalog.router)
api_router.include_router(debug_admin.router)
api_router.include_router(derived_data_freshness.router)
api_router.include_router(db_status.router)
