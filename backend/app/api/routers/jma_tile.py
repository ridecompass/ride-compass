from functools import partial
from typing import Literal

from fastapi import APIRouter, Depends, Request, Response

from app.api.cache_policy import IMMUTABLE_TILE, JMA_TARGET_TIMES
from app.api.dependencies import get_jma_tile_client
from app.api.rate_limit import enforce_rate_limit
from app.api.routers._tile_http import JMA_NOT_YET_DELIVERED_REPLIES, JMA_TILE_REPLIES
from app.config import settings
from app.infrastructure.jma_tile_client import JmaTileClient, is_target_times_path
from app.infrastructure.jma_tile_index import JmaTileIndex, get_index
from app.infrastructure.jma_tile_paths import is_final_absence
from app.domain.strict_model import StrictModel
from app.services.jma_tile_proxy_service import proxied_tile

router = APIRouter()

# このプロキシは1つのパスで性質の異なる4種類（内容が確定して以後変化しないタイル本体・
# 同じURLのまま更新される時刻一覧・恒久404・配信前の地物の404）を返すため、`cache_policy.py`の対応表では
# `HANDLER_MANAGED`とし、どのポリシーを使うかだけをここで選ぶ。キャッシュ時間そのものは
# `cache_policy.py`が持つ。


class JmaTileIndexAvailable(JmaTileIndex):
    available: Literal[True] = True


class JmaTileIndexUnavailable(StrictModel):
    """インデックス未保存・Redis障害。どのタイルについても在否を言わない。"""

    available: Literal[False] = False


# `GET /api/jma-tile-index`の応答。範囲と要素は、インデックスが在るときだけ在る。
JmaTileIndexResponse = JmaTileIndexAvailable | JmaTileIndexUnavailable


@router.get("/api/jma-tile-index", response_model=JmaTileIndexResponse)
async def jma_tile_index() -> JmaTileIndexResponse:
    """どのタイルに描くものがあるかの一覧。

    JMA動的タイルは疎で、平常時はほぼ全てのタイルが空である。載っていないタイルは要求しなくてよい。
    `available: false`のときと`coverage`の外は在否が不明で、タイルを取りに行く側に倒す
    （インデックスが無いことで表示が欠けてはならない）。
    """
    index = await get_index()
    if index is None:
        return JmaTileIndexUnavailable()
    return JmaTileIndexAvailable(coverage=index.coverage, elements=index.elements)


@router.get("/api/jma-tile/{path:path}")
async def jma_tile_proxy(
    path: str, request: Request, jma_tile_client: JmaTileClient = Depends(get_jma_tile_client)
) -> Response:
    # クエリ文字列（例: liden/slmcs系のGeoJSONが要求する?id=liden）はpathへ連結して
    # そのままキャッシュキー・上流URLの一部にする（透過プロキシのため中身を解釈しない）。
    if request.url.query:
        path = f"{path}?{request.url.query}"
    # キャッシュヒットならレート制限を一切経由しない。認証なしで叩けるプロキシへの
    # 簡易な歯止めは、実際に外部フェッチが発生するミス時のみ適用する。
    tile = await proxied_tile(
        jma_tile_client,
        path,
        partial(enforce_rate_limit, request, "jma-tile", settings.jma_tile_rate_limit_per_minute),
    )
    # 空と分かったタイルを覚えるのは404が確定したパスだけなので、覚えた空もこの選び方で確定の側に入る。
    replies = JMA_TILE_REPLIES if is_final_absence(path) else JMA_NOT_YET_DELIVERED_REPLIES
    content, content_type = replies.found(tile)
    policy = JMA_TARGET_TIMES if is_target_times_path(path) else IMMUTABLE_TILE
    return Response(content=content, media_type=content_type, headers={"Cache-Control": policy.header()})
