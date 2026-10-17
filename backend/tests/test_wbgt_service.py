"""`services/wbgt_service.py`——地点の暑さ指数の警戒レベルを、最寄りの情報提供地点の予測から選ぶ。

環境省の応答は形のまま上流の代役から返し、解くクライアントは本物を通す。

ここで見ないもの:
- 予測の中から今の1件を選ぶこと（最新の発表回・今に最も近い時刻）・値から段と呼び名を決めること・提供期間
  → `test_wbgt_domain.py`
- 配信元の応答を解くこと → `test_wbgt_client.py`
"""

from datetime import datetime

import httpx
import pytest
import respx
from shapely.geometry import Point, shape

from app.domain.route import Coordinates
from app.infrastructure import wbgt_client
from app.infrastructure.wbgt_client import new_forecast_cache, new_point_master_cache
from app.services.nearest_point_areas import new_cells_cache
from app.services.wbgt_service import WbgtService
from tests.fake_http import client_for

POINT = Coordinates(latitude=35.6812, longitude=139.7671)
SUMMER_NOW = datetime(2026, 8, 22, 15, 0, 0)
WINTER_NOW = datetime(2026, 1, 15, 12, 0, 0)

#: 地点マスタCSVのヘッダーと東京の行（使うのは地点番号・観測所名・緯度経度（度と分）・終了日の列）。
POINT_MASTER_CSV = (
    ",,地点番号,観測所名,,,,Latitude,Latitude_3,Longitude,Longitude_4,,End Year-End Month-End Day,,,,,\n"
    ",,44132,東京,,,,35,41.5,139,45.0,,9999-99-99,,,,,\n"
)


def _forecast(reference_time, forecast_time, forecast_val):
    return {"reference_time": reference_time, "wbgt_no": 44132, "forecast_val": forecast_val,
            "forecast_time": forecast_time, "flag": 0}


def _service(*, point_master=POINT_MASTER_CSV, forecast=None) -> tuple[WbgtService, respx.Router]:
    """地点マスタはCSVのまま、予測は`{"status": "success", "data": forecast}`で返す（Noneなら接続の失敗）。"""
    upstream = respx.Router()
    master = upstream.get(wbgt_client.WBGT_POINT_MASTER_URL)
    if point_master is None:
        master.mock(side_effect=httpx.ConnectError)
    else:
        master.respond(text=point_master)
    forecasts = upstream.get(wbgt_client.WBGT_FORECAST_API_URL)
    if forecast is None:
        forecasts.mock(side_effect=httpx.ConnectError)
    else:
        forecasts.respond(json={"status": "success", "data": forecast})
    service = WbgtService(
        client_for(upstream),
        point_master_cache=new_point_master_cache(),
        forecast_cache=new_forecast_cache(),
        cells_cache=new_cells_cache(),
    )
    return service, upstream


async def test_the_status_carries_the_area_the_same_point_holds_for():
    """同じ情報提供地点の予測が当たる範囲（その地点が最寄りである範囲）を添える。もう1つの地点の近くは含まない。
    範囲のために地点の表を取り直さない（予測を引くときに取った表を使う）。"""
    master = POINT_MASTER_CSV + ",,44263,大阪,,,,34,40.9,135,31.1,,9999-99-99,,,,,\n"
    service, upstream = _service(
        point_master=master, forecast=[_forecast("2026/08/22 14:00:00", "2026/08/22 15:00:00", "300")]
    )

    result = await service.get_status(POINT, now=SUMMER_NOW)

    assert result is not None and result.valid_area is not None
    area = shape(result.valid_area.model_dump())
    assert area.contains(Point(POINT.longitude, POINT.latitude))
    assert not area.contains(Point(135 + 31.1 / 60, 34 + 40.9 / 60))
    assert [call.request.url for call in upstream.calls].count(wbgt_client.WBGT_POINT_MASTER_URL) == 1


async def test_a_value_outside_the_provision_period_is_shown():
    """配信元は発表の期間の外でも値を返す年があり、その日の段を隠さない。"""
    service, _ = _service(forecast=[_forecast("2026/10/28 08:00:00", "2026/10/28 09:00:00", "300")])

    result = await service.get_status(POINT, now=datetime(2026, 10, 28, 9, 0, 0))

    assert result is not None and result.reading is not None
    assert result.reading.level == "severe_warning"
    assert result.reading.value == 30.0


@pytest.mark.parametrize("failure", [
    {"point_master": None},
    {"point_master": POINT_MASTER_CSV.splitlines()[0] + "\n"},  # 運用中の地点が1つも読めない
    {"forecast": None},
    {"forecast": []},  # 検索窓に発表が無い
    {"forecast": [_forecast("2026/08/22 14:00:00", "2026/08/22 15:00:00", None)]},  # 今の予測の値が読めない
])
@pytest.mark.parametrize(("now", "within_period"), [(SUMMER_NOW, True), (WINTER_NOW, False)])
async def test_without_a_current_value_only_inside_the_period_is_unknown(failure, now, within_period):
    """期間の中で取れなかったことを段なしで返すと、画面は警戒が要らないと見せる。期間の外は値が無いのが常で、
    失敗と出すと提供していない時期に「取得できませんでした」が出る。"""
    service, _ = _service(**failure)

    result = await service.get_status(POINT, now=now)

    if within_period:
        assert result is None
    else:
        assert result is not None and result.reading is None


@pytest.mark.parametrize(("now", "logged"), [(SUMMER_NOW, True), (WINTER_NOW, False)])
async def test_no_issuance_is_logged_only_inside_the_period(caplog, now, logged):
    """配信元の失敗はクライアントが出すが、発表の無い成功はここで出さないと502の理由がどこにも残らない。
    期間の外の発表の無い成功は正常で、出すと冬のあいだ出続ける。"""
    service, _ = _service(forecast=[])

    with caplog.at_level("WARNING", logger="ridecompass.external"):
        await service.get_status(POINT, now=now)

    assert any("発表がありません" in record.getMessage() for record in caplog.records) is logged


async def test_get_status_returns_empty_when_below_almost_safe_threshold():
    service, _ = _service(forecast=[_forecast("2026/08/22 14:00:00", "2026/08/22 15:00:00", "150")])

    result = await service.get_status(POINT, now=SUMMER_NOW)  # 15.0、21未満

    assert result is not None and result.reading is None
