"""JMA動的タイルの在否インデックス（どのタイルに描くものがあるか）。

JMA動的タイルは疎で、平常時はほぼ全てのタイルが空である。にもかかわらずクライアントは
中身の有無を知らないまま画面内の全タイルを要求し、平常時は取得のほぼ全部が空タイルに
費やされる。`basetime`が10分ごとに変わりURLも変わるため、ブラウザキャッシュ
（`api/cache_policy.py`）では救えない。

プリウォームが運用範囲のタイルを取得する過程で在否を記録し、`GET /api/jma-tile-index`で配る。
インデックスの形（`JmaTileIndex`）はここだけが宣言する。正本を持たないキャッシュで、失っても
インデックスが無いときの取り方（全タイルを取りに行く）へ戻るだけ。
"""

import json

from app.domain.strict_model import StrictModel
from app.infrastructure.cache_identity import shape_digest
from app.infrastructure.jma_tile_redis_cache import TTL_SECONDS
from app.infrastructure.redis_json_cache import UNAVAILABLE, get_json, set_json


class JmaTileIndexCoverage(StrictModel):
    """インデックスが網羅している地理範囲（プリウォームの対象bbox）。"""

    min_longitude: float
    min_latitude: float
    max_longitude: float
    max_latitude: float


class JmaTileIndexElement(StrictModel):
    """要素（risk系・nowc系・rasrf系）ごとの在否。

    `basetime`・`validtime`・`member`はクライアントが「自分が描こうとしているフレームと一致するか」を
    確かめるために使う（要素ごとに更新タイミングが異なり、1つの`basetime`に実況と複数の予測の
    `validtime`が載る）。
    """

    basetime: str | None = None
    validtime: str | None = None
    member: str = "none"
    # ズーム（JSONのオブジェクトキーなので文字列）→ 中身のあるタイル座標[x, y]の一覧。
    zooms: dict[str, list[list[int]]] = {}


class JmaTileIndex(StrictModel):
    """保存するインデックス全体。`coverage`の外は在否が不明で、クライアントは従来どおり取得する。"""

    coverage: JmaTileIndexCoverage
    elements: dict[str, JmaTileIndexElement]


_LOG_CATEGORY = "cache:jma-tile-index"
# 要素ごとに`basetime`が異なる（risk系・nowc系・rasrf系で別々に更新される）ため、
# `basetime`をキーに含めず「最新の1つ」を固定キーで持ち、どの`basetime`に対する在否かは
# ペイロード側の要素ごとに持たせる。クライアントは自分が描こうとしている`basetime`と
# 一致する要素についてだけインデックスを使う。
# キーには型から導いた版を入れる。形を変えたコードは前の形の値を読まない（別のキーになり、
# 前のキーはTTLで消える）ため、読んだ値は常に今の型で検証を通る。
_LATEST_KEY = (
    f"jma:tile-index:{shape_digest(json.dumps(JmaTileIndex.model_json_schema(), sort_keys=True))}:latest"
)


async def set_index(index: JmaTileIndex) -> None:
    """最新のインデックス全体を保存する。"""
    await set_json(
        _LATEST_KEY, index.model_dump(), ttl_seconds=TTL_SECONDS, category=_LOG_CATEGORY, operation="set"
    )


async def get_index() -> JmaTileIndex | None:
    """保存済みインデックス。未保存・Redis障害時はNone（クライアントは従来どおり全タイルを
    取りに行く）。"""
    stored = await get_json(_LATEST_KEY, category=_LOG_CATEGORY, operation="get")
    return None if stored is None or stored is UNAVAILABLE else JmaTileIndex.model_validate(stored)
