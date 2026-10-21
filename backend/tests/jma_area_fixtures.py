"""区域コード階層を引くサービスのテストが共有するデータと上流の代役。

`flood_service`・`warning_service`・`warning_timeline_service`はどれも「緯度経度→区域の境界→area.jsonの
階層→発表文書」という同じ順で引くため、上流の代役の張り方も同じになる。差し替えるのは
プロセス境界（区域の境界の置き場・気象庁への取得）だけで、応答の形を解くクライアントは本物を通す。

既定は**区域が解決できる世界**で、テストが見る区域コードはここの名前で参照する
（値を書き写すと、ここを変えたときに関係ないテストが落ちる）。
"""

import httpx
import respx
from shapely.geometry import box

from app.domain.route import Coordinates
from app.infrastructure import flood_client, jma_area_boundaries, jma_warning_client, jma_warning_timeline_client

CLASS20_CODE = "1310100"
CLASS10_CODE = "130010"
OFFICE_CODE = "130000"

#: 地域マスタ（area.json）の千代田区から府県予報区までの行。項目は実際の応答の形のまま。
AREA_DATA = {
    "class20s": {CLASS20_CODE: {"name": "千代田区", "enName": "Chiyoda City", "kana": "ちよだく", "parent": "130011"}},
    "class15s": {"130011": {"name": "２３区西部", "enName": "Western Region of 23 wards", "parent": CLASS10_CODE}},
    "class10s": {CLASS10_CODE: {"name": "東京地方", "enName": "Tokyo Region", "parent": OFFICE_CODE}},
}

#: 警報級の時系列の3時間ごとのコマの始まり。応答の`timeDefines`の値のまま。
TIMELINE_SLOT_STARTS = [
    "2026-10-21T18:00:00+09:00", "2026-10-21T21:00:00+09:00", "2026-10-22T00:00:00+09:00", "2026-10-22T03:00:00+09:00",
    "2026-10-22T06:00:00+09:00", "2026-10-22T09:00:00+09:00", "2026-10-22T12:00:00+09:00", "2026-10-22T15:00:00+09:00",
    "2026-10-22T18:00:00+09:00", "2026-10-22T21:00:00+09:00",
]
#: 千代田区の雷の段。取った日の応答はどのコマも注意報級でなかったので、段と付加事項だけ書き換えてある。
THUNDER_CODES = ["01", "20", "20", "01", "01", "01", "01", "01", "01", "01"]
THUNDER_ADDITIONS = ["突風", "ひょう"]


def _significancy(kind_type: str, locals_: list[dict]) -> dict:
    return {"status": "発表", "dateTime": "2026-10-21T17:00:00+09:00", "significancyParts": [{"type": kind_type, "locals": locals_}]}


#: 気象庁の警報級の時系列（東京都、2026-10-21 17時発表）を、千代田区と東京地方の項目と一部の種別へ絞ったもの。項目の形は
#: 実際の応答のまま（段を持たない見込みの値の欄・コマの長さの違う系列を含む）。
TIMELINE_DOCUMENT = {
    "reportDatetime": "2026-10-21T17:00:00+09:00",
    "targetDatetime": "2026-10-21T18:00:00+09:00",
    "infoType": "発表",
    "publishingOffice": "気象庁",
    "timeSeries": [
        {
            "timeDefinesKey": "7f145200e9ecb57c28bcef00431b510b08e0d02c7ff7bd72f09d80000c53d2d4",
            "timeDefines": [{"dateTime": start, "duration": "PT3H"} for start in TIMELINE_SLOT_STARTS],
            "class10Items": [
                {"areaCode": CLASS10_CODE, "kinds": [_significancy("雷危険度", [{"codes": ["01"] * 10}])]},
            ],
            "class20Items": [
                {
                    "areaCode": CLASS20_CODE,
                    "kinds": [
                        _significancy("風危険度", [{"codes": ["20", "20", "01", "01", "01", "01", "01", "01", "01", "01"]}]),
                        {
                            "status": "発表",
                            "dateTime": "2026-10-21T17:00:00+09:00",
                            "forecastParts": [
                                {
                                    "type": "風向",
                                    "locals": [{"values": [
                                        {"unit": "８方位漢字", "value": value}
                                        for value in ["南西"] * 3 + ["北"] * 5 + ["北東"] * 2
                                    ]}],
                                },
                            ],
                        },
                        _significancy("雷危険度", [{"codes": THUNDER_CODES, "additions": THUNDER_ADDITIONS}]),
                    ],
                },
            ],
        },
        {
            "timeDefinesKey": "6936c8421c23fd0f0661a7b3ee6feef66ab7bdc7ddf25e4e86250e914337e03b",
            "timeDefines": [
                {"dateTime": "2026-10-21T18:00:00+09:00", "duration": "PT24H"},
                {"dateTime": "2026-10-22T00:00:00+09:00", "duration": "PT24H"},
            ],
            "class10Items": [],
            "class20Items": [
                {
                    "areaCode": CLASS20_CODE,
                    "kinds": [
                        {
                            "status": "発表",
                            "dateTime": "2026-10-21T17:00:00+09:00",
                            "forecastParts": [
                                {"type": "２４時間最大雨量", "locals": [{"values": [{"unit": "mm", "value": "5"}, {"unit": "mm", "value": "0"}]}]},
                            ],
                        },
                    ],
                },
            ],
        },
    ],
}

CHIYODA_POINT = Coordinates(latitude=35.6812, longitude=139.7671)
#: どの区域の境界からも最寄りの区域へ寄せる距離より遠い地点（海上）。
OFFSHORE_POINT = Coordinates(latitude=34.0, longitude=141.0)


def area_lookup_upstream(
    boundary_path,
    *,
    class20_code=CLASS20_CODE,
    area_data=AREA_DATA,
    warning_documents=None,
    flood_documents=None,
    timeline_document=None,
) -> respx.Router:
    """区域の境界を`CHIYODA_POINT`を囲む1区域だけにし、気象庁の代役の経路を返す。

    境界は置き場（`boundary_path`。`tests/conftest.py`の同じ名前のフィクスチャ）へ書き、ディスクから読む本物を通す。代役は地域マスタ・
    `OFFICE_CODE`の警報・洪水予報・警報級の時系列をURLで返し（Noneなら接続の失敗）、それ以外のURL（別の府県予報区の
    警報等）を引かれたら落ちる。
    """
    jma_area_boundaries.write_boundaries(
        boundary_path,
        {class20_code: box(CHIYODA_POINT.longitude - 0.01, CHIYODA_POINT.latitude - 0.01,
                           CHIYODA_POINT.longitude + 0.01, CHIYODA_POINT.latitude + 0.01)},
    )

    payloads = {
        jma_warning_client.JMA_AREA_JSON_URL: area_data,
        jma_warning_client.JMA_WARNING_URL_TEMPLATE.format(office_code=OFFICE_CODE): warning_documents,
        flood_client.FLOOD_API_URL: flood_documents,
        jma_warning_timeline_client.JMA_WARNING_TIMELINE_URL_TEMPLATE.format(office_code=OFFICE_CODE): timeline_document,
    }

    upstream = respx.Router()
    for url, payload in payloads.items():
        if payload is None:
            upstream.get(url).mock(side_effect=httpx.ConnectError)
        else:
            upstream.get(url).respond(json=payload)
    return upstream
