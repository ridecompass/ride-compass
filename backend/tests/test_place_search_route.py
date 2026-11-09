"""`api/routers/place_search.py`——地点の検索の経路。

経路から、サービス（`services/place_search_service.py`）と住所の区画の表を引く層（`infrastructure/address_search.py`）・
施設の表を引く層（`infrastructure/facility_search.py`）の判断を見る: 住所の候補の段・表示名・位置、書き方の違う入力
（空白）、全部に当たる・番地付き・続きの3通りの当たり方とその並び（段の粗いもの → 全部に当たるもの → 続き → 中心に近いもの）、
番地付きの残りの番号で当たる街区（住居表示の区域）と地番（それ以外の区域）、
件数の上限、入力の一部にだけ当たった住所を出さないこと、施設の名前を表記の揺れを除いて部分一致で引くこと（並び・地図の
真ん中に近い店から上限まで）、群の外の地点も名前で引くこと、群の語で群の店を・チェーンの語でそのチェーンの店を名前に当たる店より
先に引くこと、検索に出さない分類、施設に添える辺り、住所と施設を並べる順と合わせての上限への配分、対象範囲を読めなければ502、回数制限。
置いた位置の辺りの口（`GET /api/place-area`）と、地図の点の名前から開くリンクの口（`GET /api/place-link`）も、同じ注入から本物を
通して見る。
住所の区画の表は、アドレス・ベース・レジストリの行（街区を含む。地番は街区レベル位置参照情報の行）を取り込んで住所の派生の段を
本物のまま流して作る。辺りは小地域の境界の行を取り込んで引く。対象範囲は道路の取込の記録から、施設は Overture の地点の取込から地点の派生の段を本物のまま流して作り、
注入から本物を通す。

ここで見ないもの:
- 対象範囲を読むこと（どの取込の記録の範囲か） → `test_ingested_area.py`
- 住所の区画・鍵・街区の作り方（範囲・祖先・鍵の別形・地番を区画に結ぶ名前・住居表示の区域で ABR を採る） → `test_address_areas.py`、表記の揃え方の1つずつ → `test_address_area.py`
- 地点の群・絞り・まとめ・住所 → `test_stop_places.py`、入力を群の語として読むか → `test_stop_place_words.py`
- 辺りの決め方（辺の上・境界の外・名前の無い境界・配布の境界の読み方） → `test_stop_place_areas.py`。置いた位置の辺りも
  同じ SQL の部品（`infrastructure/place_area_query.py: area_label_sql`）で決めるので、ここでは境界の中と外の両側だけを見る
- 回数制限の窓 → `test_rate_limiter.py`
- Cache-Control の値と、失敗の応答に付けないこと → `test_cache_policy.py`
- 入力の長さ（`domain/place_search.py: PlaceQuery`の制約で、FastAPIが422で返す）
"""

import math
from urllib.parse import quote

import httpx
import pytest
import pytest_asyncio
import shapely

from app.batch import derive_addresses, derive_places
from app.batch.ingest import SourceRecord
from app.config import settings
from app.domain.place_search import PLACE_PREDICTION_LIMIT
from app.domain.region import BoundingBox
from app.infrastructure import rate_limiter
from app.main import app
from tests.conftest import raw_connection
from tests.source_ingest import (
    abr_block_record,
    abr_city_record,
    abr_prefecture_record,
    abr_town_record,
    estat_small_area_record,
    ingest_records,
    isj_block_record,
    overture_place_record,
)

pytestmark = pytest.mark.asyncio(loop_scope="module")

#: 対象範囲（関東）。道路の取込が宣言した範囲から読まれる。
AREA = BoundingBox(min_latitude=34.9, min_longitude=138.4, max_latitude=37.2, max_longitude=140.9)
#: `httpx.ASGITransport`が要求の接続元にする番地（回数制限の鍵になる）。
CLIENT_HOST = "127.0.0.1"
#: 対象範囲の中（新宿）と外（大阪）の位置。施設は名前ごとに経度をずらして置く（チェーンでないのでまとまらない）。
#: 画面が見ている所の真ん中は、指定しなければ新宿の位置。
LON, LAT = 139.70, 35.69
OUTSIDE_LON, OUTSIDE_LAT = 135.50, 34.68


@pytest_asyncio.fixture(loop_scope="module")
async def area(road_graph_session, app_on_test_database):
    """道路の取込が対象範囲を宣言した状態。入れた行は、抜けるときに`road_graph_session`の片付けが消す。"""
    await ingest_records("osm_way", [], bbox=AREA)


async def _get(path: str, params: dict[str, object]) -> httpx.Response:
    transport = httpx.ASGITransport(app=app, client=(CLIENT_HOST, 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path, params=params)


async def _search(query: str, near_longitude: float = LON, near_latitude: float = LAT) -> httpx.Response:
    return await _get("/api/place-search", {"q": query, "latitude": near_latitude, "longitude": near_longitude})


async def _ingest_facilities(records: list[object]) -> None:
    """Overture の地点を取り込み、地点の表を作る派生の段を流す。"""
    async with raw_connection() as conn:
        await ingest_records("overture_place", records, conn=conn)
        await derive_places.derive(conn)


async def _ingest_addresses(records: list[SourceRecord], parcels: list[SourceRecord] | None = None) -> None:
    """アドレス・ベース・レジストリの行と街区レベル位置参照情報の行を取り込み、住所の区画の表を作る派生の段を流す
    （範囲は`area`の宣言）。"""
    async with raw_connection() as conn:
        await ingest_records("abr", records, conn=conn)
        await ingest_records("isj_block", parcels or [], conn=conn)
        await derive_addresses.derive(conn)


# --- 住所 ----------------------------------------------------------------------


def _town(city: SourceRecord, town_id: str, town_type: str, lon: float, lat: float, **names: str) -> SourceRecord:
    """`city`（`abr_city_record`）の市区町村に属す町字1件。"""
    attrs = city.attrs
    return abr_town_record(attrs["lg_code"], town_id, town_type, (attrs["pref"], attrs["city"], attrs["ward"]), lon, lat,
                           **names)


TOKYO = abr_prefecture_record("130001", "東京都", 139.69178, 35.68963)
SAITAMA = abr_prefecture_record("110001", "埼玉県", 139.649, 35.85736)
KANAGAWA = abr_prefecture_record("140007", "神奈川県", 139.6424, 35.4478)
SHINJUKU = abr_city_record("131041", "東京都", "新宿区", 139.703463, 35.69389)
SHIBUYA = abr_city_record("131130", "東京都", "渋谷区", 139.697948, 35.663982)
ADACHI = abr_city_record("131211", "東京都", "足立区", 139.804, 35.775)
SAITAMA_CITY = abr_city_record("111007", "埼玉県", "さいたま市", 139.645502, 35.861515)
IWATSUKI = abr_city_record("111104", "埼玉県", "さいたま市", 139.694182, 35.949882, ward="岩槻区")
KAWASAKI = abr_city_record("141305", "神奈川県", "川崎市", 139.703, 35.531)
NAKAHARA = abr_city_record("141330", "神奈川県", "川崎市", 139.657, 35.576, ward="中原区")
NISHI_SHINJUKU = _town(SHINJUKU, "0024000", "1", 139.697501, 35.690383, oaza="西新宿")
NISHI_SHINJUKU_2 = _town(SHINJUKU, "0024002", "2", 139.691774, 35.68945, oaza="西新宿", chome="二丁目")
NISHIARAI = _town(ADACHI, "0050000", "1", 139.786, 35.777, oaza="西新井")
#: 同じ名前の大字が新宿の近く（渋谷区本町）と遠く（さいたま市岩槻区本町）にある。渋谷区本町は十二丁目まで。
SHIBUYA_HONMACHI_TOWN = _town(SHIBUYA, "0030000", "1", 139.683187, 35.680992, oaza="本町")
SHIBUYA_HONMACHI_CHOMES = [
    _town(SHIBUYA, f"00300{number:02d}", "2", 139.68 + number / 1000, 35.68, oaza="本町", chome=chome)
    for number, chome in ((1, "一丁目"), (2, "二丁目"), (12, "十二丁目"))]
IWATSUKI_HONMACHI = _town(IWATSUKI, "0020000", "1", 139.693159, 35.947813, oaza="本町")
KOSUGI = _town(NAKAHARA, "0010000", "1", 139.66, 35.575, oaza="小杉")
#: 住居表示の区域の街区（西新宿二丁目8番）。
NISHI_SHINJUKU_2_8 = abr_block_record(NISHI_SHINJUKU_2, "008", "8", 139.6912, 35.6895)
#: 住居表示でない区域（郡の町の大字）と、その地番。
HINODE = abr_city_record("133051", "東京都", "日の出町", 139.257, 35.742, county="西多摩郡")
HIRAI = _town(HINODE, "0001000", "1", 139.26, 35.74, oaza="大字平井")
HIRAI_123 = isj_block_record("東京都", "西多摩郡日の出町", "大字平井", "123", 139.2612, 35.7415)
ADDRESSES = [TOKYO, SAITAMA, KANAGAWA, SHINJUKU, SHIBUYA, ADACHI, SAITAMA_CITY, IWATSUKI, KAWASAKI, NAKAHARA,
             NISHI_SHINJUKU, NISHI_SHINJUKU_2, NISHIARAI, SHIBUYA_HONMACHI_TOWN, *SHIBUYA_HONMACHI_CHOMES,
             IWATSUKI_HONMACHI, KOSUGI, NISHI_SHINJUKU_2_8, HINODE, HIRAI]
PARCELS = [HIRAI_123]


def _address(record: SourceRecord, name: str, level: str) -> dict:
    """区画の候補。位置は区画の代表点（取り込んだ行の点）。"""
    point = shapely.from_wkb(record.geom_wkb)
    return {"kind": "address", "level": level, "name": name, "area": None,
            "latitude": point.y, "longitude": point.x}


@pytest.mark.parametrize(("query", "candidates"), [
    pytest.param("東京都 新宿区　西新宿", [_address(NISHI_SHINJUKU, "東京都新宿区西新宿", "oaza")], id="空白を除く"),
    pytest.param("西新", [
        _address(NISHI_SHINJUKU, "東京都新宿区西新宿", "oaza"),
        _address(NISHIARAI, "東京都足立区西新井", "oaza"),
    ], id="打ちかけの続き"),
    # 全部に当たる二丁目（鍵「本町2-」）が、番地付きとして頭に当たる大字の本町より先。
    pytest.param("本町2", [
        _address(SHIBUYA_HONMACHI_CHOMES[1], "東京都渋谷区本町二丁目", "aza"),
        _address(SHIBUYA_HONMACHI_TOWN, "東京都渋谷区本町", "oaza"),
        _address(IWATSUKI_HONMACHI, "埼玉県さいたま市岩槻区本町", "oaza"),
    ], id="丁目の数字まで"),
    # 残りの最初の数字（8）を二丁目の街区の番号として引き、街区の点に当たる。号は持たない。
    pytest.param("西新宿2-8-1", [_address(NISHI_SHINJUKU_2_8, "東京都新宿区西新宿二丁目8番", "block")], id="番地まで"),
    pytest.param("西新宿2-99-1", [_address(NISHI_SHINJUKU_2, "東京都新宿区西新宿二丁目", "aza")],
                 id="無い街区の番号は丁目まで"),
    pytest.param("日の出町平井123番地", [_address(HIRAI_123, "東京都日の出町大字平井123番地", "block")],
                 id="地番まで"),
    pytest.param("平井124", [_address(HIRAI, "東京都日の出町大字平井", "oaza")], id="無い地番は大字まで"),
    # 十二丁目までの町の「13」は、一丁目（鍵「本町1-」）にも十二丁目にも当てず、大字の本町の番地として読む。
    pytest.param("本町13-5", [
        _address(SHIBUYA_HONMACHI_TOWN, "東京都渋谷区本町", "oaza"),
        _address(IWATSUKI_HONMACHI, "埼玉県さいたま市岩槻区本町", "oaza"),
    ], id="無い丁目の番地は大字まで"),
    # 頭の「小杉」は大字に当たるが、残りの「湯」が番地の形でない。
    pytest.param("小杉湯", [], id="入力の一部にだけ当たる住所は出さない"),
    pytest.param("あ", [], id="何も当たらない"),
    # 揃えると空の文字列で、どの鍵の頭にも当たる。
    pytest.param("大字", [], id="揃えると空になる入力"),
])
@pytest.mark.usefixtures("area")
async def test_addresses_are_the_areas_the_input_reaches(query, candidates):
    await _ingest_addresses(ADDRESSES, PARCELS)

    response = await _search(query)

    assert response.status_code == 200
    assert response.json() == {"candidates": candidates}


@pytest.mark.parametrize(("near", "first", "second"), [
    pytest.param((LON, LAT), (SHIBUYA_HONMACHI_TOWN, "東京都渋谷区本町"),
                 (IWATSUKI_HONMACHI, "埼玉県さいたま市岩槻区本町"), id="新宿で見ている"),
    pytest.param((139.69, 35.95), (IWATSUKI_HONMACHI, "埼玉県さいたま市岩槻区本町"),
                 (SHIBUYA_HONMACHI_TOWN, "東京都渋谷区本町"), id="岩槻で見ている"),
])
@pytest.mark.usefixtures("area")
async def test_areas_of_the_same_name_come_nearest_to_the_center_first(near, first, second):
    await _ingest_addresses(ADDRESSES)

    response = await _search("本町", *near)

    assert response.status_code == 200
    assert response.json() == {"candidates": [_address(*first, "oaza"), _address(*second, "oaza")]}


@pytest.mark.usefixtures("area")
async def test_a_coarser_level_comes_before_an_exact_name():
    """1文字の「柏」で、全部に当たる大字の「柏」が上限を超えてあっても、続きの柏市（鍵「柏市」）が先頭に出る。"""
    chiba = abr_prefecture_record("120006", "千葉県", 140.1233, 35.6047)
    kashiwa = abr_city_record("122173", "千葉県", "柏市", 139.975, 35.8676)
    towns = [abr_city_record(f"1230{i}0", "千葉県", f"町{i}", 140.0 + i / 100, 35.8) for i in range(PLACE_PREDICTION_LIMIT)]
    oazas = [_town(town, "0001000", "1", 140.0 + i / 100, 35.8, oaza="柏") for i, town in enumerate(towns)]
    await _ingest_addresses([chiba, kashiwa, *towns, *oazas])

    response = await _search("柏")

    assert response.status_code == 200
    assert response.json() == {"candidates": [
        _address(kashiwa, "千葉県柏市", "city"),
        *(_address(oaza, f"千葉県町{i}柏", "oaza") for i, oaza in enumerate(oazas[:PLACE_PREDICTION_LIMIT - 1])),
    ]}


@pytest.mark.usefixtures("area")
async def test_an_exact_name_comes_before_a_nearer_continuation():
    """「浅草」で、見ている所に近い「浅草橋」より、遠い「浅草」そのものが先に出る。"""
    taito = abr_city_record("131067", "東京都", "台東区", 139.779, 35.712)
    asakusa = _town(taito, "0001000", "1", 139.797, 35.715, oaza="浅草")
    asakusabashi = _town(taito, "0002000", "1", 139.786, 35.697, oaza="浅草橋")
    await _ingest_addresses([TOKYO, taito, asakusa, asakusabashi])

    response = await _search("浅草", 139.786, 35.697)

    assert response.status_code == 200
    assert response.json() == {"candidates": [
        _address(asakusa, "東京都台東区浅草", "oaza"), _address(asakusabashi, "東京都台東区浅草橋", "oaza")]}


@pytest.mark.usefixtures("area")
async def test_continuations_are_the_shortest_ones_up_to_the_limit_nearest_first():
    """続きは短い鍵から上限まで引き、その中を見ている所に近い順に並べる（長い鍵ほど近くに置く）。"""
    chiyoda = abr_city_record("131016", "東京都", "千代田区", 139.753595, 35.694003)
    oazas = {
        length: _town(chiyoda, f"00{length:02d}000", "1", 139.76 - length / 1000, 35.69,
                                oaza="西" + "あ" * length)
        for length in range(PLACE_PREDICTION_LIMIT + 1, 0, -1)}
    await _ingest_addresses([TOKYO, chiyoda, *oazas.values()])

    response = await _search("千代田区西")

    assert response.status_code == 200
    assert response.json() == {"candidates": [
        _address(oazas[length], f"東京都千代田区西{'あ' * length}", "oaza")
        for length in range(PLACE_PREDICTION_LIMIT, 0, -1)]}


@pytest.mark.usefixtures("road_graph_session", "app_on_test_database")
async def test_the_search_is_a_failure_when_the_area_cannot_be_read():
    """対象範囲が読めない（DB障害・道路を未取込）ときは、候補を範囲で絞れない。"""
    response = await _search("東京都新宿区")

    assert response.status_code == 502
    assert response.json() == {"detail": "検索する範囲の情報を取得できませんでした"}


# --- 施設 ----------------------------------------------------------------------

def _facility(name: str, longitude: float, latitude: float = LAT, area: str | None = None) -> dict:
    """施設の候補。辺りは住所の区画と境界を取り込んだテスト（施設の辺りの節）だけが持つ。"""
    return {"kind": "facility", "level": "point", "name": name, "area": area, "latitude": latitude,
            "longitude": longitude}


@pytest.mark.parametrize("query", [
    pytest.param("一蘭新宿", id="名前の一部"),
    pytest.param("ｲﾁﾗﾝ", id="半角のかな"),
    pytest.param("らーめん 一蘭", id="空白"),
])
@pytest.mark.usefixtures("area")
async def test_facilities_are_found_by_a_part_of_the_name_within_the_area(query):
    await _ingest_facilities([
        overture_place_record(1, LON, LAT, "らーめん一蘭 新宿店"),
        overture_place_record(2, LON + 0.01, LAT, "イチラン・カフェ"),
        overture_place_record(3, OUTSIDE_LON, OUTSIDE_LAT, "一蘭 道頓堀店"),
        overture_place_record(4, LON + 0.02, LAT, "ラーメン一風堂"),
    ])

    response = await _search(query)

    assert response.status_code == 200
    expected = {
        "一蘭新宿": [_facility("らーめん一蘭 新宿店", LON)],
        "ｲﾁﾗﾝ": [_facility("イチラン・カフェ", LON + 0.01)],
        "らーめん 一蘭": [_facility("らーめん一蘭 新宿店", LON)],
    }[query]
    assert response.json() == {"candidates": expected}


@pytest.mark.usefixtures("area")
async def test_facilities_are_ordered_by_how_the_name_matches_then_by_the_distance():
    """名前が入力と同じ → 入力で始まる → 入力を含む。同じ中では、画面が見ている所の真ん中に近い順（名前の長さに依らない）。
    近さは測地の距離: 東へ経度0.01度（約0.90km）の店が、北へ緯度0.009度（約1.00km）の店より先（度のままなら逆になる）。"""
    await _ingest_facilities([
        overture_place_record(1, LON, LAT, "珈琲こすぎ"),
        overture_place_record(2, LON + 0.01, LAT, "こすぎコーヒー店"),
        overture_place_record(3, LON, LAT + 0.009, "こすぎ亭"),
        overture_place_record(4, LON + 0.03, LAT, "こすぎ"),
    ])

    response = await _search("こすぎ", near_longitude=LON)

    assert response.status_code == 200
    assert response.json() == {"candidates": [
        _facility("こすぎ", LON + 0.03),
        _facility("こすぎコーヒー店", LON + 0.01),
        _facility("こすぎ亭", LON, LAT + 0.009),
        _facility("珈琲こすぎ", LON),
    ]}


@pytest.mark.usefixtures("area")
async def test_a_short_input_finds_only_the_names_beginning_with_it():
    """打ちかけの1〜2文字の入力は、名前がその入力で始まる施設だけを引く（名前の途中に含む施設は3文字目から）。名前の部分一致の
    索引は3文字の組で引くので、短い語で途中まで引くと全行を読んで遅い。"""
    await _ingest_facilities([
        overture_place_record(1, LON, LAT, "珈琲小杉"),
        overture_place_record(2, LON + 0.01, LAT, "小杉亭"),
        overture_place_record(3, LON + 0.02, LAT, "小杉"),
    ])

    response = await _search("小杉")

    assert response.status_code == 200
    assert response.json() == {"candidates": [_facility("小杉", LON + 0.02), _facility("小杉亭", LON + 0.01)]}


@pytest.mark.usefixtures("area")
async def test_a_facility_nearer_on_the_ground_comes_first_even_when_degrees_scaled_by_latitude_say_otherwise():
    """経度の差に中心の緯度の余弦を掛けて度で比べると遠い店でも、測地の距離で近ければ先に出る。東西の1度は南北の1度に
    余弦を掛けたものより地球の扁平の分だけ長いので、北の店は、東の上限の件数の店より度では遠く、地面では近い。"""
    north = LAT + 0.01 * math.cos(math.radians(LAT)) * 1.002
    await _ingest_facilities(
        [overture_place_record(i, LON + 0.01 - i / 1e6, LAT, "喫茶ことり") for i in range(PLACE_PREDICTION_LIMIT)]
        + [overture_place_record(PLACE_PREDICTION_LIMIT, LON, north, "喫茶ことり")])

    response = await _search("喫茶ことり")

    assert response.status_code == 200
    assert [(c["longitude"], c["latitude"]) for c in response.json()["candidates"]] == [(LON, north)] + [
        (LON + 0.01 - i / 1e6, LAT) for i in range(PLACE_PREDICTION_LIMIT - 1, 0, -1)
    ]


#: 群「コンビニ」に入る Overture の分類（群はチェーンの名前の店だけを入れる）。
CONVENIENCE_STORE = ("shopping", "convenience_store")


@pytest.mark.usefixtures("area")
async def test_a_name_of_a_group_finds_the_nearest_stores_of_the_group_before_the_names_it_matches():
    """「コンビニ」と打つと、名前に「コンビニ」を含まない近くのコンビニの店が、名前が入力と同じ店（より近くても）より先に近い順に出る。"""
    await _ingest_facilities([
        overture_place_record(1, LON, LAT, "コンビニ"),
        overture_place_record(2, LON + 0.02, LAT, "セブン-イレブン 西新宿店", CONVENIENCE_STORE),
        overture_place_record(3, LON + 0.01, LAT, "ファミリーマート 新宿店", CONVENIENCE_STORE),
        overture_place_record(4, OUTSIDE_LON, OUTSIDE_LAT, "ローソン 道頓堀店", CONVENIENCE_STORE),
        overture_place_record(5, LON + 0.005, LAT, "ラーメン一風堂"),
    ])

    response = await _search("コンビニ")

    assert response.status_code == 200
    assert response.json() == {"candidates": [
        _facility("ファミリーマート 新宿店", LON + 0.01),
        _facility("セブン-イレブン 西新宿店", LON + 0.02),
        _facility("コンビニ", LON),
    ]}


@pytest.mark.usefixtures("area")
async def test_a_place_outside_the_groups_is_found_by_its_name():
    """どの群にも入らない分類の地点（駅・公園の外の店・役所）も、名前で引ける。"""
    await _ingest_facilities([
        overture_place_record(1, LON, LAT, "新宿駅", ("travel_and_transportation", "train_station")),
        overture_place_record(2, LON + 0.01, LAT, "新宿区役所", ("community_and_government", "government_office")),
    ])

    response = await _search("新宿")

    assert response.status_code == 200
    assert response.json() == {"candidates": [_facility("新宿駅", LON), _facility("新宿区役所", LON + 0.01)]}


#: 自転車屋の分類。
BIKE_STORE = ("shopping", "sporting_goods_store", "bike_store")


@pytest.mark.usefixtures("area")
async def test_a_name_of_a_chain_finds_its_stores_written_in_either_letters():
    """チェーンの名前（「ワイズロード」）で、名前がカタカナの店と英字の店（「Y's Road」）の両方が近い順に出る。"""
    await _ingest_facilities([
        overture_place_record(1, LON + 0.02, LAT, "ワイズロード上野アサゾー", BIKE_STORE),
        overture_place_record(2, LON + 0.01, LAT, "Y's Road 新宿クロスバイク館", BIKE_STORE),
        overture_place_record(3, LON + 0.005, LAT, "サイクルベースあさひ 新宿店", BIKE_STORE),
    ])

    response = await _search("ワイズロード")

    assert response.status_code == 200
    assert response.json() == {"candidates": [
        _facility("Y's Road 新宿クロスバイク館", LON + 0.01), _facility("ワイズロード上野アサゾー", LON + 0.02)]}


@pytest.mark.usefixtures("area")
async def test_a_name_of_the_bicycle_group_finds_bicycle_stores_and_not_bike_share_ports():
    """「自転車屋」と打つと、見ている所により近いシェアサイクルの貸し場（貸し自転車の分類に入っている）ではなく、自転車屋が出る。
    貸し場は自分の自転車で走る人の行き先にならない。"""
    rental = ("sports_and_recreation", "recreational_equipment_rental", "bike_rental")
    await _ingest_facilities([
        overture_place_record(1, LON + 0.001, LAT, "HELLO CYCLING 新宿三丁目", rental),
        overture_place_record(2, LON + 0.002, LAT, "千代田区コミュニティサイクル ちよくる A4-04", rental),
        overture_place_record(3, LON + 0.01, LAT, "ワイズロード新宿カスタム", BIKE_STORE),
    ])

    response = await _search("自転車屋")

    assert response.status_code == 200
    assert response.json() == {"candidates": [_facility("ワイズロード新宿カスタム", LON + 0.01)]}


@pytest.mark.usefixtures("area")
async def test_places_of_the_categories_not_searched_are_not_found():
    """店の中の機械・付属物（貸し出しの機械・ATM・駐車場・受け取りロッカー）は、店の名前で入っていても検索に出ない。"""
    await _ingest_facilities([
        overture_place_record(1, LON, LAT, "ライフ石神井公園店", ("shopping", "grocery_store")),
        overture_place_record(2, LON + 0.001, LAT, "ライフ石神井公園店",
                              ("services_and_business", "rental_service", "rental_kiosk")),
        overture_place_record(3, LON + 0.002, LAT, "ライフ石神井公園店 駐車場", ("travel_and_transportation", "parking")),
    ])

    response = await _search("ライフ石神井")

    assert response.status_code == 200
    assert response.json() == {"candidates": [_facility("ライフ石神井公園店", LON)]}


@pytest.mark.usefixtures("area")
async def test_an_input_without_letters_finds_no_facility():
    """表記の揺れを除くと空になる入力（中点・ハイフンだけ）は、どの名前にも含まれるとみなさない。"""
    await _ingest_facilities([overture_place_record(1, LON, LAT, "小杉湯")])

    response = await _search("・-")

    assert response.status_code == 200
    assert response.json() == {"candidates": []}


@pytest.mark.usefixtures("area")
async def test_addresses_come_before_facilities():
    """施設は、検索の中心に住所より近くても住所の後に並ぶ。"""
    await _ingest_addresses(ADDRESSES)
    await _ingest_facilities([overture_place_record(1, LON, LAT, "小杉湯")])

    response = await _search("小杉")

    assert response.status_code == 200
    assert response.json() == {"candidates": [
        _address(KOSUGI, "神奈川県川崎市中原区小杉", "oaza"),
        _facility("小杉湯", LON),
    ]}


@pytest.mark.parametrize(("addresses", "facilities", "shown"), [
    pytest.param(3, PLACE_PREDICTION_LIMIT, (3, PLACE_PREDICTION_LIMIT - 3), id="住所が少ない"),
    pytest.param(PLACE_PREDICTION_LIMIT, 3, (PLACE_PREDICTION_LIMIT - 3, 3), id="施設が少ない"),
    pytest.param(PLACE_PREDICTION_LIMIT, PLACE_PREDICTION_LIMIT,
                 (PLACE_PREDICTION_LIMIT // 2, PLACE_PREDICTION_LIMIT // 2), id="両方が多い"),
])
@pytest.mark.usefixtures("area")
async def test_addresses_and_facilities_share_the_limit(addresses, facilities, shown):
    """候補（地図の印）は住所と施設を合わせて上限まで。両方が多ければ半分ずつ、片方が少なければもう片方が空いた分を埋める。"""
    chiba = abr_prefecture_record("120006", "千葉県", 140.1233, 35.6047)
    towns = [abr_city_record(f"1240{i:02d}", "千葉県", f"町{i}", 140.0 + i / 100, 35.8) for i in range(addresses)]
    await _ingest_addresses([chiba, *towns, *(_town(town, "0001000", "1", 140.0 + i / 100, 35.8, oaza="梅")
                                              for i, town in enumerate(towns))])
    await _ingest_facilities([overture_place_record(i, LON + i / 1000, LAT, f"梅の店{i}") for i in range(facilities)])

    response = await _search("梅")

    assert response.status_code == 200
    kinds = [candidate["kind"] for candidate in response.json()["candidates"]]
    assert (kinds.count("address"), kinds.count("facility")) == shown


# --- 施設の辺り ------------------------------------------------------------------


async def _ingest_boundaries() -> None:
    """新宿区西新宿二丁目（`LON`・`LAT`の周り）とさいたま市岩槻区本町（経度139.70・緯度35.95の周り）の小地域の境界を取り込む。"""
    await ingest_records("estat_small_area", [
        estat_small_area_record("13104002402", "新宿区", "西新宿二丁目", [
            (LON - 0.002, LAT - 0.002), (LON - 0.002, LAT + 0.002), (LON + 0.002, LAT + 0.002),
            (LON + 0.002, LAT - 0.002), (LON - 0.002, LAT - 0.002)]),
        estat_small_area_record("11110000100", "さいたま市岩槻区", "本町", [
            (139.69, 35.94), (139.69, 35.96), (139.71, 35.96), (139.71, 35.94), (139.69, 35.94)]),
    ])


@pytest.mark.usefixtures("area")
async def test_facilities_of_the_same_name_show_the_area_each_one_is_in():
    """チェーンの名前で探すと同じ表示名の店が並ぶので、辺り（店の位置を含む小地域の境界の、市区町村から先の名前）で
    見分ける。"""
    await _ingest_boundaries()
    await _ingest_facilities([
        overture_place_record(1, LON, LAT, "ファミリーマート"),
        overture_place_record(2, 139.70, 35.95, "ファミリーマート"),
    ])

    response = await _search("ファミリーマート")

    assert response.status_code == 200
    assert response.json() == {"candidates": [
        _facility("ファミリーマート", LON, LAT, "新宿区西新宿二丁目"),
        _facility("ファミリーマート", 139.70, 35.95, "さいたま市岩槻区本町"),
    ]}


# --- 置いた位置の辺り ------------------------------------------------------------


async def _area_at(longitude: float, latitude: float) -> httpx.Response:
    return await _get("/api/place-area", {"latitude": latitude, "longitude": longitude})


@pytest.mark.parametrize(("longitude", "latitude", "expected"), [
    pytest.param(LON + 0.001, LAT, "新宿区西新宿二丁目", id="境界の中"),
    pytest.param(OUTSIDE_LON, OUTSIDE_LAT, None, id="境界の外"),
])
@pytest.mark.usefixtures("area")
async def test_a_placed_point_shows_the_area_it_is_in(longitude, latitude, expected):
    """地図で置いた地点・現在地にも、施設の辺りと同じ形の辺り（位置を含む小地域の境界の、市区町村から先の名前）を出す。"""
    await _ingest_boundaries()

    response = await _area_at(longitude, latitude)

    assert response.status_code == 200
    assert response.json() == {"area": expected}


# --- 地図の点の名前から開くリンク --------------------------------------------------


async def _place_link(name: str, longitude: float, latitude: float) -> httpx.Response:
    return await _get("/api/place-link", {"name": name, "latitude": latitude, "longitude": longitude})


@pytest.mark.parametrize(("name", "longitude", "latitude", "query"), [
    pytest.param("ワイズロード渋谷", LON + 0.0005, LAT, "ワイズロード渋谷,渋谷区道玄坂2丁目10-7", id="住所のある地点"),
    pytest.param("すみれ茶屋", LON - 0.0005, LAT, "すみれ茶屋,新宿区西新宿二丁目", id="使える住所の無い地点は地点の辺り"),
    pytest.param("地図だけの店", LON + 0.001, LAT, "地図だけの店,新宿区西新宿二丁目", id="地点が無ければ位置の辺り"),
    pytest.param("海の店", OUTSIDE_LON, OUTSIDE_LAT, None, id="辺りも無ければリンクを持たない"),
])
@pytest.mark.usefixtures("area")
async def test_a_point_on_the_map_opens_the_outside_map_with_its_name_and_where_it_is(name, longitude, latitude, query):
    """地図の点の名前から開く外の地図（Google マップの検索）は「名前,所在」で引く。所在は、同じ名前の近くの地点の住所 →
    その地点の辺り → 点の位置の辺りの順で、どれも無ければリンクを持たない（名前だけで引くと別の場所の店を開く）。別の都道府県が
    混ざった住所は使わない。"""
    await _ingest_boundaries()
    await _ingest_facilities([
        overture_place_record(1, LON + 0.0005, LAT, "ワイズロード渋谷", BIKE_STORE,
                              address={"freeform": "渋谷区道玄坂2丁目10-7", "locality": "渋谷区", "region": None}),
        overture_place_record(2, LON - 0.0005, LAT, "すみれ茶屋",
                              address={"freeform": "沖縄県那覇市字安里48番地", "locality": "北区", "region": None}),
    ])

    response = await _place_link(name, longitude, latitude)

    assert response.status_code == 200
    assert response.json() == {
        "url": None if query is None else "https://www.google.com/maps/search/?api=1&query=" + quote(query, safe="")}


@pytest.mark.parametrize(("prefix", "limit", "path", "params"), [
    pytest.param("place-search", settings.place_search_rate_limit_per_minute, "/api/place-search",
                 {"q": "本町", "latitude": LAT, "longitude": LON}, id="検索"),
    pytest.param("place-area", settings.place_area_rate_limit_per_minute, "/api/place-area",
                 {"latitude": LAT, "longitude": LON}, id="置いた位置の辺り"),
    pytest.param("place-link", settings.place_link_rate_limit_per_minute, "/api/place-link",
                 {"name": "店", "latitude": LAT, "longitude": LON}, id="地図の点の名前から開くリンク"),
])
@pytest.mark.usefixtures("area")
async def test_each_route_is_rate_limited_per_client(prefix, limit, path, params):
    for _ in range(limit - 1):
        rate_limiter.check_rate_limit(f"{prefix}:{CLIENT_HOST}", limit)

    assert (await _get(path, params)).status_code == 200
    assert (await _get(path, params)).status_code == 429
