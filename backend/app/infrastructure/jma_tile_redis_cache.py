"""JMA動的タイル（ラスタPNG・洪水ベクタPBF）本体のRedis cache-aside。

値はContent-Type・NULバイト・本体をこの順につないだ生のバイト列で1キーに持ち、ヒットのたびにデコードを払わない。
0バイトの値は「描くものが無い」（`infrastructure/http_client.py: UPSTREAM_NOT_FOUND`）を表す——中身が空のタイルは
実体を保存しないため、本物のタイルと重ならない。
"""

import hashlib

from app.infrastructure.http_client import UPSTREAM_NOT_FOUND, UpstreamNotFound
from app.infrastructure.jma_tile_content import is_empty_tile
from app.infrastructure.jma_tile_recolor import RECOLOR_VERSION
from app.infrastructure.redis_json_cache import UNAVAILABLE, get_bytes, set_bytes

# 保存するのは中継が塗り替えたあとのタイルなので、塗り替えの版を鍵に入れる。
_KEY_PREFIX = f"jma:tile:{RECOLOR_VERSION}"
_CATEGORY = "cache:jma-tile-redis"
# プリウォームの間隔より余裕を持たせ、1回のプリウォームの失敗・遅延で即座に空にならないようにする。
TTL_SECONDS = 20 * 60


def _extension(path: str) -> str:
    """`.../{z}/{x}/{y}.png`のような配信パスから拡張子だけを取り出す
    （クエリ文字列付きのパスもそのままキーになるため、末尾から素直に切る）。"""
    return path.rsplit(".", 1)[-1].split("?", 1)[0] if "." in path else ""


def _key(path: str) -> str:
    return f"{_KEY_PREFIX}:{hashlib.sha256(path.encode('utf-8')).hexdigest()}"


def _decode(raw: bytes) -> tuple[bytes, str] | UpstreamNotFound:
    if raw == b"":
        return UPSTREAM_NOT_FOUND
    content_type, _separator, content = raw.partition(b"\0")
    return content, content_type.decode("latin-1")


async def get(path: str) -> tuple[bytes, str] | UpstreamNotFound | None:
    """Redisキャッシュ済みなら(内容, Content-Type)または`UPSTREAM_NOT_FOUND`。未キャッシュ・Redis障害時はNone。"""
    cached = await get_bytes(_key(path), decode=_decode, category=_CATEGORY, path=path)
    return None if cached is UNAVAILABLE else cached


async def set(path: str, content: bytes, content_type: str) -> tuple[bytes, str] | UpstreamNotFound:
    """取得できたタイルをRedisへ書き戻し、次に`get`が返すのと同じ形で返す。

    中身が空なら実体ではなく`UPSTREAM_NOT_FOUND`と同じフラグで持つ（空のタイルは在否インデックスから外れ、
    実体が読まれるのはインデックスが届く前だけ）。
    """
    if is_empty_tile(content, _extension(path)):
        await set_empty(path)
        return UPSTREAM_NOT_FOUND
    value = content_type.encode("latin-1", errors="replace") + b"\0" + content
    await set_bytes(_key(path), value, ttl_seconds=TTL_SECONDS, category=_CATEGORY, path=path)
    return content, content_type


async def set_empty(path: str) -> None:
    """このパスに描くものが無いと確認したときに呼ぶ（上流の確定した404、または200で返った空タイル）。"""
    await set_bytes(_key(path), b"", ttl_seconds=TTL_SECONDS, category=_CATEGORY, path=path)
