"""JMA指定河川洪水予報APIのクライアント。

`https://www.jma.go.jp/bosai/flood/data/r8/flood_xml.json`は全国の現在発表中/直近解除済みの
指定河川洪水予報を1つの配列で返す（府県別・河川別に分かれておらず1回のGETで完結する）。
更新頻度が高くなく機械アクセス制限の明記も無いので、再試行は設けずTTLキャッシュのみで済ませる。取得の失敗は投げる。
電文の形はここで解き、呼び出し元へは`FloodBulletin`で渡す。

電文のコード→段の表は、気象庁「指定河川洪水予報」電文フォーマット解説資料の表２
（令和8年度出水期以降の対応表）を典拠とする。
"""

import httpx
from cachetools import TTLCache

from app.domain.flood_forecast import FloodBulletin
from app.domain.warning_levels import WarningBadgeLevel
from app.infrastructure.simple_api_client import UnexpectedShapeError, cached_fetch, get_json

FLOOD_API_URL = "https://www.jma.go.jp/bosai/flood/data/r8/flood_xml.json"

# 発表は数十分単位で更新されうるので、10分より長く持たない。
_FLOOD_CACHE_TTL_SECONDS = 10 * 60


def new_flood_cache() -> TTLCache:
    """`fetch_flood_documents`へ渡す、全国1本の電文一覧のキャッシュ。"""
    return TTLCache(maxsize=1, ttl=_FLOOD_CACHE_TTL_SECONDS)

# 電文の`item.code`→段。状態の文字列ではなくコード自体が
# 発表・継続・上位の警報の解除による引き下げを分ける（例: "20"=新規発表、"21"=継続、"22"=引き下げ）。
# 完全解除（今は発表が無い）を表すコード"10"は載せない——載っているコードはどれも発表中、が表の意味である。
# どちらにも無いコードは、写した表が配信元のコード表より古くなった印で、段なしとして出さずに飛ばすと出ている予報が消えて見える。
_LIFTED_CODE = "10"
_CODE_LEVELS: dict[str, WarningBadgeLevel] = {
    "20": "advisory",
    "21": "advisory",
    "22": "advisory",
    "30": "warning",
    "31": "warning",
    "40": "severe_warning",
    "41": "severe_warning",
    "51": "emergency_warning",
    "53": "emergency_warning",
}

#: 運用の電文の`status`。これ以外（訓練・試験）の電文は上へ渡さない。
_OPERATIONAL_STATUS = "通常"


def _parse_bulletin(entry: dict) -> FloodBulletin:
    """運用の電文1件。項目が欠けていれば投げる。表に無い段のコードなら投げる。"""
    item = entry["item"]
    code = item["code"]
    if code != _LIFTED_CODE and code not in _CODE_LEVELS:
        raise UnexpectedShapeError(f"flood bulletin code missing from _CODE_LEVELS: {code}（flood_client.py）")
    return FloodBulletin(
        level=_CODE_LEVELS.get(code),
        class20_codes=tuple(entry["class20Codes"]),
        class10_codes=tuple(entry["class10Codes"]),
        river_code=entry["riverCode"],
        river_name=entry["riverName"],
        condition=item["condition"],
    )


async def fetch_flood_documents(client: httpx.AsyncClient, cache: TTLCache) -> list[FloodBulletin]:
    """全国の指定河川洪水予報のうち運用の電文。1件=1河川の最新状態（発表・継続・解除の
    いずれか）で、解除された河川も解除のコードのまま残り続ける。"""

    async def fetch() -> list[FloodBulletin]:
        payload = await get_json(client, FLOOD_API_URL, list, "flood bulletins are")
        return [_parse_bulletin(entry) for entry in payload if entry["status"] == _OPERATIONAL_STATUS]

    return await cached_fetch("weather:jma-flood", fetch, cache=cache)
