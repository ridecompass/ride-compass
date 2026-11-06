"""環境省 熱中症予防情報サイトのクライアント。

情報提供地点マスタ（CSV）と暑さ指数（WBGT）予測値取得WebAPI（JSON、典拠は
`man15NH/wbgt_data_api_service_manual.pdf`）を叩く。サイト側の利用上の注意
（wbgt_data_download.php）が自動化ツールからの高頻度アクセスを控えるよう求めるため、再試行は設けず
TTLキャッシュで呼び出し頻度自体を抑える。取得失敗はNoneを返す。
"""

import csv
import io
from datetime import datetime

import httpx
from cachetools import TTLCache

from app.domain.time_zone import JST
from app.domain.wbgt import WbgtForecast, WbgtPoint
from app.infrastructure.simple_api_client import UnexpectedShapeError, cached_fetch

# ファイル名に更新日が入るため、地点構成が変わったらURLごと差し替える（自動では追従しない）。
WBGT_POINT_MASTER_URL = "https://www.wbgt.env.go.jp/man15NH/wbgt_point_master-20260515.csv"
WBGT_FORECAST_API_URL = "https://www.wbgt.env.go.jp/api/v1/getForecastData"

# 地点構成は年1回程度しか変わらない。予測値は3時間刻みでしか更新されない。
_POINT_MASTER_CACHE_TTL_SECONDS = 24 * 60 * 60
_FORECAST_CACHE_TTL_SECONDS = 60 * 60



def new_point_master_cache() -> TTLCache:
    """`fetch_point_master`へ渡すキャッシュ。"""
    return TTLCache(maxsize=1, ttl=_POINT_MASTER_CACHE_TTL_SECONDS)


def new_forecast_cache() -> TTLCache:
    """`fetch_forecast`へ渡すキャッシュ。鍵は地点番号で、全国の地点（約840）が退避されない大きさ。"""
    return TTLCache(maxsize=2048, ttl=_FORECAST_CACHE_TTL_SECONDS)


async def fetch_point_master(client: httpx.AsyncClient, cache: TTLCache) -> list[WbgtPoint]:
    """情報提供地点マスタのうち運用中の地点を取得する。"""

    async def fetch() -> list[WbgtPoint]:
        response = await client.get(WBGT_POINT_MASTER_URL)
        response.raise_for_status()
        return _parse_point_master(response.text)

    return await cached_fetch("weather:wbgt-point-master", fetch, cache=cache)


def _parse_point_master(csv_text: str) -> list[WbgtPoint]:
    """地点マスタCSVから、運用中の地点の番号・名称・緯度経度を取り出す。

    **列の典拠はCSVの先頭行（ヘッダー）そのもの**で、別の仕様書は無い。18列あり、
    使うのは`地点番号`(2)・`観測所名`(3)・`Latitude`(7)/`Latitude_3`(8)・
    `Longitude`(9)/`Longitude_4`(10)・`End Year-End Month-End Day`(12)。

    ヘッダーを読んでも分からないことが2つある。**緯度経度は度と分に分かれている**
    （`45`と`31.2`で45度31.2分）ので、度へ直すには分を60で割って足す。終了日の
    `9999-99-99`は**運用中**を表す番兵で、それ以外の日付が入っている地点は終了済み。

    **セルは前後に余白を持ちうる**ため、使う前に落とす。余白付きの地点番号はそのまま
    予測値APIのクエリへ載り、その地点の予測が引けなくなる。
    """
    reader = csv.reader(io.StringIO(csv_text))
    # 空行はデータ行に数えない（配布CSVの末尾に付きうる）。
    rows = [row for row in list(reader)[1:] if any(cell.strip() for cell in row)]  # 先頭行はヘッダー
    # 読めない行（列が足りない・座標が数でない）は投げる。読める行だけを残すと、遠い地点の値が何事もなく表示される。
    return [
        WbgtPoint(
            no=row[2].strip(),
            name=row[3].strip(),
            latitude=float(row[7].strip()) + float(row[8].strip()) / 60.0,
            longitude=float(row[9].strip()) + float(row[10].strip()) / 60.0,
        )
        for row in rows
        if row[12].strip() == "9999-99-99"  # 運用終了済み地点は近傍検索の対象外
    ]


def _parse_forecast(entry: dict) -> WbgtForecast:
    """予測値1件。予測の時刻と値は無いことがある（None）。"""
    raw_time = entry.get("forecast_time")
    raw_value = entry.get("forecast_val")
    return WbgtForecast(
        reference_time=entry["reference_time"],
        forecast_time=None if raw_time is None else datetime.strptime(raw_time, "%Y/%m/%d %H:%M:%S"),
        # 配信元は暑さ指数を10倍した整数文字列で返す（例: "280"→28.0）。
        wbgt=None if raw_value is None else float(raw_value) / 10.0,
    )


async def fetch_forecast(
    client: httpx.AsyncClient, wbgt_no: str, range_from: datetime, range_to: datetime, cache: TTLCache
) -> list[WbgtForecast]:
    """指定地点の暑さ指数予測値列を取得する。`range_from`/`range_to`は発表時刻（reference_time）の検索範囲で、
    範囲の中の発表回をすべて返す。date_search_type=3（特定時刻）は指定時刻ちょうどの発表が無いと空を返し、
    発表は遅れうるので、連続期間指定（1）で取る。"""
    params: dict[str, str | int] = {
        "location_type": 1,
        "date_search_type": 1,
        "wbgt_nos": wbgt_no,
        "range_date_from": _query_time(range_from),
        "range_date_to": _query_time(range_to),
    }

    async def fetch() -> list[WbgtForecast]:
        response = await client.get(WBGT_FORECAST_API_URL, params=params)
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict) or body.get("status") != "success":
            raise UnexpectedShapeError("wbgt forecast response is not successful")
        data = body.get("data")
        if not isinstance(data, list):
            raise UnexpectedShapeError(f"wbgt forecast data is {type(data).__name__}")
        return [_parse_forecast(entry) for entry in data]

    return await cached_fetch("weather:wbgt-forecast", fetch, cache=cache, key=wbgt_no, wbgt_no=wbgt_no)


def _query_time(at: datetime) -> str:
    return at.astimezone(JST).strftime("%Y%m%d%H%M%S")
