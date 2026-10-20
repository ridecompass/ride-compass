"""タイルを配るエンドポイントで共通のHTTP層。

タイルのrouterが、座標検証・応答の組み立て・地域タイルのレート制限と同時実行の上限をそれぞれ個別に持つのを避けるため
共有する。レート制限の数え方は全router共通の`app.api.rate_limit.enforce_rate_limit`が持つ。
"""

import asyncio
from dataclasses import dataclass
from typing import TypeVar

from fastapi import HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic_core import PydanticCustomError

from app.api.rate_limit import enforce_rate_limit
from app.api.cache_policy import (
    GSI_TILE_NOT_FOUND,
    JMA_NOT_YET_DELIVERED,
    JMA_TILE_NOT_FOUND,
    NO_STORE,
    CachePolicy,
)
from app.config import settings
from app.domain.region import check_tile_index
from app.infrastructure.http_client import UpstreamNotFound
from app.infrastructure.media_types import MVT_CONTENT_TYPE
from app.infrastructure.region_tile_cache import TileResponse

T = TypeVar("T")

# 地域タイル（路面・点）の同時実行上限
# （settings.road_tile_max_concurrent、値の根拠はconfig.py参照）。
#
# 上限超過分は即座に429を返すルート生成とは異なり、こちらは「待たせて全件処理する」
# （semaphoreの取得をブロックさせる）方式にしている。MapLibreは失敗したタイル要求を
# 自動再試行しないため、429にすると1画面に収まる範囲で上限を超えるタイル（皇居周辺のような
# 広い範囲では珍しくない）が永久に空白のまま描画されなくなる（詳細は
# docs/modules/backend/static-road-attributes.md参照）。/healthはこのsemaphoreを
# 経由しない別の同期ハンドラのため、待機中のタイル要求に巻き込まれず応答し続けられる。
#
# 点のタイルも同じDB接続プールを取り合うため、専用semaphoreを新設せずこれを
# 共有する（プール上限15接続に対し、独立semaphoreを追加すると種類ごとのタイルの同時実行数の
# 合計がプール上限を超えうる）。
region_tile_semaphore = asyncio.Semaphore(settings.road_tile_max_concurrent)


def check_tile_rate_limit(request: Request, prefix: str) -> None:
    """地域タイル向けの`enforce_rate_limit`の薄いラッパー。どれも「パン/ズームのたびに
    1画面ぶんが飛ぶ」同じ負荷の形のため同じ上限値（settings.road_tile_rate_limit_per_minute）
    を使うが、キー・記録先の`prefix`は種別ごとに分ける。
    """
    enforce_rate_limit(request, prefix, settings.road_tile_rate_limit_per_minute)


def validate_tile_coords(z: int, x: int, y: int) -> None:
    """タイルで共通の座標の検査。ズームの範囲と列・行の下限は経路の引数の型（レイヤーのズームの型・
    `domain/region.py: TileIndex`）が見るので、ここは列・行の上限（ズームに依る）だけを、型の検査と同じ422で断る。

    MapLibre側もsourceのminzoom/maxzoomと世界の範囲の外は要求しないが、直接APIを叩かれた場合の安全弁。
    """
    try:
        check_tile_index(z, x, y)
    except PydanticCustomError as error:
        raise RequestValidationError(
            [{"type": error.type, "loc": ("path",), "msg": error.message(), "input": {"z": z, "x": x, "y": y}}]
        ) from None


def tile_response(tile: TileResponse, media_type: str = MVT_CONTENT_TYPE) -> Response:
    """タイル応答を組み立てる。

    通常は`api/cache_policy.py`の対応表（`BATCH_TILE`）がミドルウェアで`Cache-Control`を
    付けるが、一時的な失敗で空タイルを返した場合だけは`no-store`を明示して、その空白が
    利用者のブラウザへ1時間残らないようにする（`TileResponse`のdocstring参照）。
    """
    headers = None if tile.cacheable else {"Cache-Control": NO_STORE.header()}
    return Response(content=tile.content, media_type=media_type, headers=headers)


@dataclass(frozen=True)
class UpstreamReplies:
    """上流から中継する配信元の、上流に無い（404）・取得に失敗した（502）ときの応答。"""

    not_found_detail: str
    #: この404をブラウザに持たせる時間。Noneは`Cache-Control`を付けない（ミドルウェアは2xxにしか付けない）。
    not_found_policy: CachePolicy | None
    failed_detail: str

    def found(self, result: T | UpstreamNotFound | None) -> T:
        """取れた中身。上流に無いは404、取得の失敗は502として送出する。

        上流に無いのは配信元が持たない正常系で、上流障害（502）と分ける。502は一時的なので、キャッシュさせない。
        """
        if isinstance(result, UpstreamNotFound):
            headers = None if self.not_found_policy is None else {"Cache-Control": self.not_found_policy.header()}
            raise HTTPException(status_code=404, detail=self.not_found_detail, headers=headers)
        if result is None:
            raise HTTPException(status_code=502, detail=self.failed_detail)
        return result


_TILE_NOT_FOUND_DETAIL = "指定されたタイルは存在しません"
_JMA_FAILED_DETAIL = "気象庁データの取得に失敗しました"

#: 基礎地図の部品（書体の一部等）。
BASEMAP_REPLIES = UpstreamReplies("指定されたリソースは存在しません", None, "地図タイルの取得に失敗しました")
GSI_TILE_REPLIES = UpstreamReplies(_TILE_NOT_FOUND_DETAIL, GSI_TILE_NOT_FOUND, "地理院タイルの取得に失敗しました")
#: 気象庁の、404が確定した事実のパス（`infrastructure/jma_tile_paths.py: is_final_absence`）。
JMA_TILE_REPLIES = UpstreamReplies(_TILE_NOT_FOUND_DETAIL, JMA_TILE_NOT_FOUND, _JMA_FAILED_DETAIL)
#: 気象庁の、配信前にも404を返すパス。
JMA_NOT_YET_DELIVERED_REPLIES = UpstreamReplies(_TILE_NOT_FOUND_DETAIL, JMA_NOT_YET_DELIVERED, _JMA_FAILED_DETAIL)
