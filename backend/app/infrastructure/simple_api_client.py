"""シンプルな外部APIクライアント（TTLCacheのみ、再試行を持たない）が共有する
「キャッシュ参照→fetch→キャッシュ書き戻し」の骨格。取得の失敗は投げる（口は`api/failure_replies.py`が502にする）。
"""

import asyncio
from collections.abc import Awaitable, Callable, Hashable

import httpx
from cachetools import TTLCache

from app.infrastructure.debug_log import log_external_call

#: 「まだ引いていない」を表す番兵。`None`は上流が返す正常な答え（該当なし）であり、
#: 未取得と同じ値にすると該当なしがTTLの間ずっとキャッシュされず、毎回上流を叩く。
_NOT_CACHED = object()

#: キャッシュと鍵ごとの、上流へ取りに行っている最中の取得。取得はキャッシュを参照で持つので、その間`id(cache)`は別の
#: キャッシュに使い回されない。
_in_flight: dict[tuple[int, Hashable], asyncio.Task] = {}


class UnexpectedShapeError(ValueError):
    """fetchが返した内容の形が想定と異なる場合に送出する。"""


#: 配信の中身を読む途中で、項目が欠けている・型が違う・値が読めないときにPythonが投げる例外。
_SHAPE_ERRORS = (KeyError, IndexError, TypeError, ValueError)


async def get_json[J: (dict, list)](client: httpx.AsyncClient, url: str, expected: type[J], shape_error_prefix: str) -> J:
    """`url`をGETしてJSONを読む。`expected`の型でなければ`UnexpectedShapeError`
    （文は`<shape_error_prefix> <届いた型の名前>`）。"""
    response = await client.get(url)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, expected):
        raise UnexpectedShapeError(f"{shape_error_prefix} {type(payload).__name__}")
    return payload


async def cached_fetch[T](
    category: str,
    fetch: Callable[[], Awaitable[T]],
    *,
    cache: TTLCache | None = None,
    key: Hashable = None,
    **log_fields: object,
) -> T:
    """`fetch()`を呼んで返す。失敗は投げる（`log_external_call`が失敗として記録する）。

    `cache`を渡すと`key`で引き、ミスしたときだけ`fetch()`を呼ぶ。同じ`cache`と`key`へ取得の最中に来た要求は、
    `fetch()`を呼ばずにその取得の結果を待つ（失敗も同じ失敗として受ける）。待っていた要求が切れても、取得は続けて
    キャッシュへ書く。**上流が「該当なし」として返した`None`もキャッシュする**——未取得と区別しないと、該当なしの
    問い合わせがTTLの間ずっと上流へ流れ続ける。`cache`を渡さない場合は毎回`fetch()`を呼ぶ。
    """
    with log_external_call(category, **log_fields) as fields:
        pending: Awaitable[T]
        if cache is None:
            pending = fetch()
        else:
            cached = cache.get(key, _NOT_CACHED)
            if cached is not _NOT_CACHED:
                fields["cache"] = "hit"
                return cached
            pending = asyncio.shield(_shared_fetch(fetch, cache, key, fields))
        try:
            data = await pending
        except _SHAPE_ERRORS as error:
            # 読み方は項目ごとの形を確かめずにそのまま読むので、欠け・型の違いはここで配信の形の誤りにする（口は502）。
            raise UnexpectedShapeError(f"{category}: {error!r}") from error
        fields["result"] = "ok"
        return data


def _shared_fetch[T](fetch: Callable[[], Awaitable[T]], cache: TTLCache, key: Hashable, fields: dict) -> asyncio.Task:
    """`cache`の`key`へ取りに行っている最中の取得を返す。無ければ始める（その要求をミスとして記録する）。"""
    flight_key = (id(cache), key)
    task = _in_flight.get(flight_key)
    if task is not None:
        fields["cache"] = "hit"
        return task
    fields["cache"] = "miss"

    async def fetch_into_cache() -> T:
        data = await fetch()
        cache[key] = data
        return data

    task = asyncio.ensure_future(fetch_into_cache())
    _in_flight[flight_key] = task
    task.add_done_callback(lambda _: _in_flight.pop(flight_key, None))
    return task
