"""JMA警報・注意報API、地域マスタ(area.json)のクライアント。

どちらも分単位では動かないため、429前提の再試行は設けない。取得の失敗は投げ、「警報なし」とは分ける。

警報のコード→種別の名称の表は、気象庁「気象警報・注意報（Ｒ０６）」電文フォーマット解説資料の別表3
（警戒レベル等対応コード表、令和8年5月29日の運用切替以降の現行r8スキーマ）を典拠とする。表は決まった所から
機械で読める形では配られないため、ここへ写して持つ（警報のページは圧縮したスクリプトの中へ埋め込み、
防災情報XMLの技術資料 https://xml.kishou.go.jp/tec_material.html はコード表を版の日付入りのファイル名で置く）。
"""

from dataclasses import dataclass

import httpx
from cachetools import TTLCache

from app.domain.jma_area import AreaEntry, AreaMaster
from app.domain.jma_warning import NOT_RELEVANT_TO_CYCLING, AreaWarningKind, WarningBulletin
from app.infrastructure.simple_api_client import UnexpectedShapeError, cached_fetch, get_json

JMA_AREA_JSON_URL = "https://www.jma.go.jp/bosai/common/const/area.json"
JMA_WARNING_URL_TEMPLATE = "https://www.jma.go.jp/bosai/warning/data/r8/{office_code}.json"

# area.jsonは行政区画変更でしか変わらない。警報は数分〜数十分単位で更新されうる。
_AREA_DATA_CACHE_TTL_SECONDS = 24 * 60 * 60
_WARNING_CACHE_TTL_SECONDS = 10 * 60


# 別表3の全コード→種別の名称。「レベルN」の接頭辞は段（`domain/jma_warning.py: warning_level`）が名称から
# 導くため省く。対応表で※1（予約領域）とされ割り当ての無いコードは含めない。
WARNING_KINDS: dict[str, str] = {
    "00": "解除",
    "02": "暴風雪警報",
    "03": "大雨警報",
    "04": "洪水警報",
    "05": "暴風警報",
    "06": "大雪警報",
    "07": "波浪警報",
    "08": "高潮警報",
    "09": "土砂災害警報",
    "10": "大雨注意報",
    "12": "大雪注意報",
    "13": "風雪注意報",
    "14": "雷注意報",
    "15": "強風注意報",
    "16": "波浪注意報",
    "17": "融雪注意報",
    "18": "洪水注意報",
    "19": "高潮注意報",
    "20": "濃霧注意報",
    "21": "乾燥注意報",
    "22": "なだれ注意報",
    "23": "低温注意報",
    "24": "霜注意報",
    "25": "着氷注意報",
    "26": "着雪注意報",
    "27": "その他の注意報",
    "29": "土砂災害注意報",
    "32": "暴風雪特別警報",
    "33": "大雨特別警報",
    "35": "暴風特別警報",
    "36": "大雪特別警報",
    "37": "波浪特別警報",
    "38": "高潮特別警報",
    "39": "土砂災害特別警報",
    "43": "大雨危険警報",
    "48": "高潮危険警報",
    "49": "土砂災害危険警報",
}

_UNNAMED_IRRELEVANT = sorted(NOT_RELEVANT_TO_CYCLING - set(WARNING_KINDS.values()))
if _UNNAMED_IRRELEVANT:
    # 出さない側に書いた名称が表に無ければ、その指定は何も起きないまま残る。
    raise RuntimeError(f"出さない種別の名称が警報のコード表に無い: {_UNNAMED_IRRELEVANT}")

# 種別が「現在発表中」であることを示す状態。「解除」（直前まで出ていたが取り下げられた）と
# 「発表警報・注意報はなし」（元々何も出ていない、コード自体を持たない）はどちらも発表中ではない。
_ACTIVE_STATUSES = frozenset({"発表", "継続"})


def new_area_data_cache() -> TTLCache:
    """`fetch_area_data`へ渡すキャッシュ。"""
    return TTLCache(maxsize=1, ttl=_AREA_DATA_CACHE_TTL_SECONDS)


def new_warning_cache() -> TTLCache:
    """`fetch_warning_documents`へ渡すキャッシュ。府県予報区（約50）が退避されない大きさで、鮮度はTTLで保つ。"""
    return TTLCache(maxsize=256, ttl=_WARNING_CACHE_TTL_SECONDS)


def _parse_area_master(payload: dict) -> AreaMaster:
    return AreaMaster(**{
        key: {code: AreaEntry(parent=entry["parent"], name=entry["name"]) for code, entry in payload[key].items()}
        for key in ("class20s", "class15s", "class10s")
    })


@dataclass(frozen=True)
class _RawKind:
    """電文の1種別の、読み替える前の字句。"""

    code: str | None
    status: str | None
    additions: tuple[str, ...]


def _parse_kind(kind: dict) -> _RawKind:
    """電文の1種別。警報が何も無い地域の種別は`{"status": "発表警報・注意報はなし"}`でコードを持たない。"""
    return _RawKind(code=kind.get("code"), status=kind.get("status"), additions=tuple(kind.get("additions", ())))


_RawArea = dict[str, tuple[_RawKind, ...]]


def _parse_area_items(items: list | None) -> _RawArea:
    """地域ごとの種別（項目が無ければ空）。同じ地域のコードが2度現れたら最初の項目を使う。"""
    kinds_by_area: _RawArea = {}
    for item in items or ():
        kinds_by_area.setdefault(item["areaCode"], tuple(_parse_kind(kind) for kind in item["kinds"]))
    return kinds_by_area


def _parse_bulletin(document: dict) -> tuple[_RawArea, _RawArea]:
    """電文1件の区域・二次細分区域ごとの種別。"""
    warning = document["warning"]
    return _parse_area_items(warning.get("class20Items")), _parse_area_items(warning.get("class10Items"))


def _read_kinds(kinds_by_area: _RawArea) -> dict[str, tuple[AreaWarningKind, ...]]:
    """コードを種別の名称へ、状態を発表中かへ読み替える。コードの無い「なし」と表に無いコードは載せない。"""
    return {
        area_code: tuple(
            AreaWarningKind(
                code=kind.code,
                name=WARNING_KINDS[kind.code],
                active=kind.status in _ACTIVE_STATUSES,
                additions=kind.additions,
            )
            for kind in kinds
            if kind.code in WARNING_KINDS
        )
        for area_code, kinds in kinds_by_area.items()
    }


def _parse_bulletins(payload: list, office_code: str) -> list[WarningBulletin]:
    parsed = [_parse_bulletin(document) for document in payload]
    # 発表中なのに表に無いコードは、写した表が配信元のコード表より古くなった印。出さずに飛ばすと、出ている警報が消えて見える。
    unknown = sorted({
        kind.code
        for class20_kinds, class10_kinds in parsed
        for kinds in (*class20_kinds.values(), *class10_kinds.values())
        for kind in kinds
        if kind.code is not None and kind.status in _ACTIVE_STATUSES and kind.code not in WARNING_KINDS
    })
    if unknown:
        raise UnexpectedShapeError(
            f"active warning codes missing from WARNING_KINDS: {unknown} office={office_code}（jma_warning_client.py）"
        )
    return [
        WarningBulletin(class20_kinds=_read_kinds(class20_kinds), class10_kinds=_read_kinds(class10_kinds))
        for class20_kinds, class10_kinds in parsed
    ]


async def fetch_area_data(client: httpx.AsyncClient, cache: TTLCache) -> AreaMaster:
    """気象庁の地域マスタ(area.json)を取得する。"""

    async def fetch() -> AreaMaster:
        payload = await get_json(client, JMA_AREA_JSON_URL, dict, "area master is")
        return _parse_area_master(payload)

    return await cached_fetch("weather:jma-area", fetch, cache=cache)


async def fetch_warning_documents(
    client: httpx.AsyncClient, office_code: str, cache: TTLCache
) -> list[WarningBulletin]:
    """指定した府県予報区コードの警報・注意報電文一覧（r8スキーマ）を取得する。電文は種別の組ごとに別なので、
    1地点でも複数電文の配列になる。"""

    async def fetch() -> list[WarningBulletin]:
        payload = await get_json(
            client,
            JMA_WARNING_URL_TEMPLATE.format(office_code=office_code),
            list,
            "warning bulletins are",
        )
        return _parse_bulletins(payload, office_code)

    return await cached_fetch("weather:jma-warning", fetch, cache=cache, key=office_code, office_code=office_code)
