"""地域タイル（路面・点・土地被覆）のディスクの口。鍵（`cache_identity.py`）・キャッシュ確認→取得→書き戻しの骨格・
前の形の掃除・作り直したあとに捨てる口を持ち、配信のサービスとは系統・世代・座標の値でやり取りする。

**鍵の世代はコードから決まる形だけで、DBの中身を持たない。** 派生の表を作り直した・道の区分を書き換えたことは鍵に表れないので、
書いた側が終わりに`discard_region_tiles`で捨てる。捨てたあとも、ブラウザは持っているタイルを`Cache-Control`の`max-age`の間
出し続ける（`api/cache_policy.py`）。

取込範囲の外かはタイル種別ごとに違うため、呼び出し元が渡す`fetch_tile`がNoneで知らせる。
"""

import asyncio
import inspect
from collections.abc import Awaitable, Callable, Mapping
from types import MappingProxyType

from app.domain import road_features
from app.domain.hard_filters import HARD_FILTERS
from app.domain.registry import TileKind
from app.domain.road_network import RoadNetwork, edge_key, positions_in
from app.infrastructure import tile_cache
from app.infrastructure.landcover_raster import raster_paths
from app.infrastructure.cache_identity import (
    LANDCOVER_TILE_VERSION,
    raster_set_fingerprint,
    region_tile_generation_prefix,
    region_tile_key,
    region_tile_kind,
    shape_digest,
)
from app.infrastructure.debug_log import log_external_call
from app.infrastructure.point_tile_layers import POINT_TILE_LAYERS
from app.infrastructure.road_network_store import NETWORK_SHAPE
from app.infrastructure.road_tile_sql import ROAD_SURFACE_TILE_SHAPE, TILE_FEATURES_SQL

#: 土地被覆ラスタタイルの系統名。DBから焼かないので、DBから焼くタイルの系統（`TileKind`）の外にある。
LANDCOVER_TILE_KIND = "landcover"

#: DBから焼いて配るタイルの系統と、ディスクの鍵の世代（形の署名）。路面タイルは地図の線の層の値（道路網の配列の材料に道の区分を
#: 当てたもの）と、当たる0次ハードフィルタを焼くので、配列の形とフィルタの条件と、タイルのフィーチャーの鍵を読むSQLと、その鍵で
#: 配列から値を引くコードの全文も入れる。点のレイヤーはそれぞれ自分のSQLだけから署名を持つので、1つのSQLを変えても他のレイヤーの
#: 鍵は変わらない。
MVT_TILE_GENERATIONS: Mapping[TileKind, str] = MappingProxyType({
    "road_surface": shape_digest(ROAD_SURFACE_TILE_SHAPE, TILE_FEATURES_SQL, NETWORK_SHAPE, HARD_FILTERS, *(
        inspect.getsource(code) for code in (
            road_features, positions_in, edge_key, RoadNetwork.__dict__["edge_first_rows"].func,
            RoadNetwork.__dict__["edge_keys"].func))),
    **{layer.name: layer.shape for layer in POINT_TILE_LAYERS.values()},
})


def landcover_generation(raster_paths: list[str]) -> str:
    """`raster_paths`のラスタから描く土地被覆ラスタタイルのディスクの世代。**ラスタの構成**も入れる。

    タイルの中身はどのラスタから描いたかに従属する。対応範囲を広げるためゾーンを1枚
    足しても鍵が同じだと、継ぎ目のタイルは古い絵（片側が透明のまま）を返し続ける。
    """
    raster_set = raster_set_fingerprint(raster_paths)
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
    variant: str = "",
) -> bytes:
    """キャッシュにあればそれを、無ければ`fetch_tile`で作ってディスクへ書いたものを返す。`fetch_tile`がNone（取込範囲の外）なら空タイル。"""
    key = region_tile_key(kind, generation, z, x, y, extension, variant)
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


def prune_other_generations() -> int:
    """今のコードの形でない地域タイルをディスクから消し、消した数を返す。

    形が変わるのはデプロイだけなので、起動のあとに1回呼ぶ（`main.py`）。土地被覆は今の置き場のラスタ構成の世代を残す。
    どの系統の表にも無い系統（改名・廃止した系統）の鍵も消す——もう誰も読まない。
    """
    generations: dict[str, str] = dict(MVT_TILE_GENERATIONS.items())
    generations[LANDCOVER_TILE_KIND] = landcover_generation(raster_paths())

    def is_stale(key: str) -> bool:
        kind = region_tile_kind(key)
        if kind is None:
            return False
        if kind not in generations:
            return True
        return not key.startswith(region_tile_generation_prefix(kind, generations[kind]))

    return tile_cache.delete_where(is_stale)


def discard_region_tiles() -> int:
    """ディスクの地域タイル（全系統）を全部消し、消したタイルの数を返す。

    タイルが焼く中身（派生の表・道の区分）を変えた側が、変更をコミットしたあとに呼ぶ。コミットの前に読み始めて捨てたあとに
    書き終えた1枚は、前の中身のまま次に捨てるまで残る。
    """
    return tile_cache.delete_where(lambda key: region_tile_kind(key) is not None)
