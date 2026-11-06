"""`infrastructure/flood_client.py`——指定河川洪水予報の全国の電文一覧を引き、電文の形を解く。

入口は`fetch_flood_documents`。網は respx の経路（`tests/fake_http.py: client_for`）で通す。
キャッシュは呼ぶ側が渡すもので、テストごとに新しく作る。

ここで見ないもの:
- 出発地点への該当と、段の呼び名 → `test_flood_forecast_domain.py`
- キャッシュの期限切れ・失敗の記録の骨格 → `simple_api_client.py: cached_fetch`の持ち物で、
  期限そのものは`cachetools`が持つ
"""


import httpx
import respx

from app.infrastructure import flood_client
from app.infrastructure.flood_client import new_flood_cache
from tests.fake_http import client_for

URL = "https://www.jma.go.jp/bosai/flood/data/r8/flood_xml.json"

KANDA = {
    "status": "通常",
    "reportDatetime": "2026-07-01T10:00:00+09:00",
    "riverCode": "8030100001",
    "riverName": "神田川",
    "class20Codes": ["1310100", "1310200"],
    "class10Codes": ["130011"],
    "item": {"code": "40", "condition": "氾濫危険情報"},
}


def answering(**response) -> tuple[httpx.AsyncClient, respx.Route]:
    router = respx.Router()
    route = router.get(URL).respond(**response)
    return client_for(router), route


async def test_an_operational_bulletin_is_read_into_its_fields():
    client, _ = answering(json=[KANDA])

    (bulletin,) = await flood_client.fetch_flood_documents(client, new_flood_cache())

    assert bulletin.level == "severe_warning"
    assert bulletin.condition == "氾濫危険情報"
    assert bulletin.class20_codes == ("1310100", "1310200")
    assert bulletin.class10_codes == ("130011",)
    assert bulletin.river_code == "8030100001"
    assert bulletin.river_name == "神田川"


async def test_drills_are_left_out():
    client, _ = answering(json=[{**KANDA, "status": "訓練"}, KANDA])

    bulletins = await flood_client.fetch_flood_documents(client, new_flood_cache())

    assert [b.river_name for b in bulletins] == ["神田川"]

async def test_a_lifted_code_has_no_level():
    """完全解除のコード（配信元の資料の表２）は発表中の段を持たない。"""
    client, _ = answering(json=[{**KANDA, "item": {**KANDA["item"], "code": "10"}}])

    (bulletin,) = await flood_client.fetch_flood_documents(client, new_flood_cache())

    assert bulletin.level is None


async def test_the_national_list_is_fetched_once_and_reused():
    client, route = answering(json=[KANDA])

    cache = new_flood_cache()

    first = await flood_client.fetch_flood_documents(client, cache)
    second = await flood_client.fetch_flood_documents(client, cache)

    assert first == second
    assert route.call_count == 1

