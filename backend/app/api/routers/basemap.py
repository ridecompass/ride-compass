from fastapi import APIRouter, Depends, Request, Response

from app.api.admin_auth import require_admin_basic_auth
from app.api.dependencies import get_basemap_client
from app.api.rate_limit import enforce_rate_limit
from app.api.routers._tile_http import BASEMAP_REPLIES
from app.config import settings
from app.infrastructure import tile_cache
from app.infrastructure.basemap_client import BasemapClient

router = APIRouter()


@router.get("/api/basemap/{path:path}")
async def basemap_proxy(
    path: str, request: Request, basemap_client: BasemapClient = Depends(get_basemap_client)
) -> Response:
    # 認証なしで叩けるプロキシへの簡易な歯止め。OpenFreeMapへの中継を伴うため、
    # 無制限に叩かれると外部サービス負荷やディスク消費に繋がる。
    enforce_rate_limit(request, "basemap", settings.basemap_rate_limit_per_minute)
    content, content_type = BASEMAP_REPLIES.found(await basemap_client.get(path))
    return Response(content=content, media_type=content_type)


@router.post(
    "/api/admin/basemap/refresh",
    dependencies=[Depends(require_admin_basic_auth)],
)
def basemap_refresh() -> dict[str, str]:
    """サーバー側のタイルファイルキャッシュを全消去する（管理画面`/admin`「データ保守」タブから使う）。

    基礎地図タイルと路面ベクタタイルは同じファイルキャッシュを共有しているため、この
    一括クリアで両方とも消える。影響は押した人だけでなく**全利用者**に及ぶ（次のタイル要求で
    作り直されるまで、外部サービスへの実問い合わせやタイル生成が走る）ため、管理APIの認可の内側に置く。

    各利用者の画面へ反映されるのは、ブラウザが持つ既存タイルの`Cache-Control`が切れた後。
    """
    tile_cache.clear_all()
    return {"status": "ok"}
