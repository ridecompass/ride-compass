import asyncio

import httpx
from cachetools import LRUCache

from app.domain.gsi_tiles import GSI_TILE_ORIGIN
from app.infrastructure import tile_cache
from app.infrastructure.debug_log import log_external_call
from app.infrastructure.http_client import UPSTREAM_NOT_FOUND, UpstreamNotFound, fetch_upstream
from app.infrastructure.media_types import PNG_CONTENT_TYPE

#: 整備区域外の記憶に使う上限付きLRUの大きさ（キー=path）。
NOT_FOUND_MAX_ENTRIES = 2000


class GsiTileClient:
    """国土地理院の標高タイルをパスで指定して取り、ファイルシステムにキャッシュする。

    書式の解釈は持たない——標高タイルをMapLibreが読む形へ移す変換は
    `gsi_dem_png.py`が担う。地理院タイルは時刻依存パラメータを持たない
    静的データのため、キャッシュにTTLは要らない。
    """

    def __init__(self, http_client: httpx.AsyncClient, not_found_paths: LRUCache):
        """`not_found_paths`は**呼び出し側が持つ**。

        地理院のタイルは整備区域外で404を返す（恒久的に正しい事実で、再取得しても変わらない）。
        このクライアントはリクエストごとに作られるため、記憶を自分で持つと毎回空になる。
        一方でプロセスより長く持つとGSI側の整備区域が広がったときに取り直す機会が無くなるので、
        `tile_cache`の永続ファイルへは書かず、渡された入れ物へだけ残す。
        """
        self._http_client = http_client
        self._not_found_paths = not_found_paths

    async def get(self, path: str) -> tuple[bytes, str] | UpstreamNotFound:
        if path in self._not_found_paths:
            return UPSTREAM_NOT_FOUND
        with log_external_call("gsi:dem-tile", path=path) as fields:
            # tile_cacheの読み書きは同期的なディスクI/Oなので、多数のタイル要求でイベントループを止めないよう別スレッドへ逃がす。
            cached = await asyncio.to_thread(tile_cache.get, path)
            if cached is not None:
                fields["cache"] = "hit"
                return cached
            fields["cache"] = "miss"

            response = await fetch_upstream(self._http_client, f"{GSI_TILE_ORIGIN}/{path}", fields)
            if isinstance(response, UpstreamNotFound):
                # 404は整備区域外。
                self._not_found_paths[path] = None
                return response

            content_type = response.headers.get("content-type", PNG_CONTENT_TYPE)
            content = response.content
            await asyncio.to_thread(tile_cache.set, path, content, content_type)
            return content, content_type
