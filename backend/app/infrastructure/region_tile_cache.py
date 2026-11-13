"""地域タイル（路面・点・土地被覆）のディスクの口。鍵（`cache_identity.py`）・キャッシュ確認→取得→書き戻しの骨格・
旧世代の掃除を持ち、配信のサービスとは系統・世代・座標の値でやり取りする。

取込範囲の外かはタイル種別ごとに違うため、呼び出し元が渡す`fetch_tile`がNoneで知らせる。
"""

import asyncio
from collections.abc import Awaitable, Callable, Mapping

from app.domain.registry import TileKind
from app.config import settings
from app.infrastructure import tile_cache
from app.infrastructure.cache_identity import (
    LANDCOVER_TILE_VERSION,
    raster_set_fingerprint,
    region_tile_generation_prefix,
    region_tile_key,
    region_tile_kind,
)
from app.infrastructure.debug_log import log_external_call

#: 土地被覆ラスタタイルの系統名。DBの世代を持たないので、世代の表（`TileKind`）の外にある。
LANDCOVER_TILE_KIND = "landcover"

#: 旧世代を消す間隔。世代が変わるのは派生の作り直し・取込・タイルのSQLを変えたデプロイで、どれも日に1回より
#: 稀なので、消し遅れて積むのはおおむね1世代ぶんで済む（それ以上は容量の上限が退避する）。
PRUNE_INTERVAL_HOURS = 24


def landcover_generation() -> str:
    """土地被覆ラスタタイルのディスクの世代。**ラスタの構成**も入れる。

    タイルの中身はどのラスタから描いたかに従属する。対応範囲を広げるためゾーンを1枚
    足しても鍵が同じだと、継ぎ目のタイルは古い絵（片側が透明のまま）を返し続ける。
    描くのは設定したラスタが全部開けたときだけなので、設定の一覧から作る。
    """
    raster_set = raster_set_fingerprint(settings.lulc_raster_paths_list)
    return f"{LANDCOVER_TILE_VERSION}/{raster_set}"


async def serve_region_tile(
    *,
    kind: str,
    generation: str,
    z: int,
    x: int,
    y: int,
    extension: str,
    empty_tile: bytes,
    content_type: str,
    external_call_name: str,
    fetch_tile: Callable[[dict], Awaitable[bytes | None]],
    source_label: str = "postgis",
) -> bytes:
    """キャッシュにあればそれを、無ければ`fetch_tile`で作ってディスクへ書いたものを返す。`fetch_tile`がNone（取込範囲の外）なら空タイル。"""
    key = region_tile_key(kind, generation, z, x, y, extension)
    with log_external_call(external_call_name, z=z, x=x, y=y) as fields:
        # ディスクの読み書きは同期のI/O。地図を開くと多数のタイルが同時に来るため、イベントループの上で行うと
        # 同時に処理中の他の要求が止まる。
        cached = await asyncio.to_thread(tile_cache.get, key)
        if cached is not None:
            fields["cache"] = "hit"
            content, _content_type = cached
            return content
        fields["cache"] = "miss"

        tile_bytes = await fetch_tile(fields)
        if tile_bytes is None:
            fields["source"] = "uncovered_empty"
            return empty_tile

        # どこから作ったか（`source_label`）はタイル種別で違う。/api/debug/statsの内訳が
        # 実際の取得元と食い違わないよう、呼び出し元が名乗る。
        fields["source"] = source_label
        fields["tile_bytes"] = len(tile_bytes)
        await asyncio.to_thread(tile_cache.set, key, tile_bytes, content_type)
        return tile_bytes


def prune_other_generations(tile_versions: Mapping[TileKind, str]) -> int:
    """配っていない世代の地域タイルをディスクから消し、消した数を返す。

    `tile_versions`はDBの世代から組んだ系統名→配信する世代（`services/tile_version_service.py:
    current_tile_versions`）。土地被覆の世代はここで足す。どの系統の表にも無い系統（改名・廃止した系統）の鍵も
    消す——もう誰も読まない。
    """
    generations: dict[str, str] = {kind: version for kind, version in tile_versions.items()}
    generations[LANDCOVER_TILE_KIND] = landcover_generation()

    def is_stale(key: str) -> bool:
        kind = region_tile_kind(key)
        if kind is None:
            return False
        if kind not in generations:
            return True
        return not key.startswith(region_tile_generation_prefix(kind, generations[kind]))

    return tile_cache.delete_where(is_stale)
