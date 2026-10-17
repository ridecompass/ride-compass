"""タイルを配るエンドポイントで共通のHTTP層。

タイルのrouterが、座標検証と応答の組み立てをそれぞれ個別に実装するのを避けるため共有する。レート制限は
タイル系に限らず全router共通の`app.api.rate_limit.enforce_rate_limit`を使う（本モジュールの対象外）。
"""

from dataclasses import dataclass
from typing import TypeVar

from fastapi import HTTPException, Response
from fastapi.exceptions import RequestValidationError
from pydantic_core import PydanticCustomError

from app.api.cache_policy import (
    GSI_TILE_NOT_FOUND,
    JMA_NOT_YET_DELIVERED,
    JMA_TILE_NOT_FOUND,
    NO_STORE,
    CachePolicy,
)
from app.domain.region import check_tile_index
from app.infrastructure.http_client import UpstreamNotFound
from app.infrastructure.media_types import MVT_CONTENT_TYPE
from app.infrastructure.region_tile_cache import TileResponse

T = TypeVar("T")


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
