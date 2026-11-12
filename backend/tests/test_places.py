"""地点の表（`places`）の群・まとめ・住所を、Overture の地点の配布の形から作る。立ち寄り先は群を持つ行。

入口は取込（`ingest_source`。アダプタ`overture_places`は本物で、手元の Parquet を読む）と派生の段
（`derive_places.derive`）。配布の形の小さな見本を Parquet に書いて置き場に置き、表に入った地点を見る。

ここで見ないもの:
- 配布元から手元へ写す取得（`scripts/fetch_overture_places.py`）→ どのテストも通さない（網の向こうの S3 を読むだけで、
  判断を持たない）
- 表を焼いた点のタイル → `test_point_tiles.py`
- 地点の辺り → `test_stop_place_areas.py`
- 地点を検索で引く（チェーンの語・検索に出さない分類）→ `test_place_search_route.py`
"""

from pathlib import Path

import duckdb
import pytest

from app.batch import derive_places
from app.batch.ingest import ingest_source
from app.batch.source_adapters import overture_places
from app.batch.source_profile import load_source_profile
from app.domain.geo import KM_PER_DEGREE_LATITUDE, km_per_degree_longitude
from app.infrastructure.source_models import Source

pytestmark = pytest.mark.asyncio(loop_scope="module")

PROFILE = load_source_profile(None)
ROWS: overture_places.OverturePlaceRows = PROFILE.source(Source.OVERTURE_PLACE).rows

LON = 139.70
LAT = 35.65
#: 経度の1mの度。
M = 1 / (km_per_degree_longitude(LAT) * 1000)
#: 緯度の1mの度。
M_LAT = 1 / (KM_PER_DEGREE_LATITUDE * 1000)
#: 見本どうしを、まとめる距離（30m）より十分に離す間。
APART = 1000 * M

FOOD = ["food_and_drink", "restaurant", "asian_restaurant"]
STORE = ["shopping", "convenience_store"]
BIKE_STORE = ["shopping", "sporting_goods_store", "bike_store"]


def _place(place_id: str, lon: float, hierarchy: list[str], *, confidence: float = 0.9,
           brand: str | None = None, lat: float = LAT, websites: list[str] | None = None,
           phones: list[str] | None = None, address: dict | None = None) -> dict:
    return {"id": place_id, "lon": lon, "lat": lat, "confidence": confidence, "name": place_id,
            "brand": brand, "hierarchy": hierarchy, "websites": websites, "phones": phones,
            "addresses": None if address is None else [address]}


def _write_parquet(path: Path, places: list[dict]) -> None:
    """配布の列の形（公式のスキーマの places の place）のうち、取込が読む列で書く。"""
    with duckdb.connect() as conn:
        conn.execute(
            "CREATE TABLE p (id VARCHAR, geometry GEOMETRY,"
            " bbox STRUCT(xmin DOUBLE, xmax DOUBLE, ymin DOUBLE, ymax DOUBLE), confidence DOUBLE,"
            ' names STRUCT("primary" VARCHAR), brand STRUCT(names STRUCT("primary" VARCHAR)),'
            ' taxonomy STRUCT("primary" VARCHAR, hierarchy VARCHAR[]), websites VARCHAR[], phones VARCHAR[],'
            ' addresses STRUCT(freeform VARCHAR, locality VARCHAR, region VARCHAR)[])')
        conn.executemany(
            "INSERT INTO p VALUES (?, ?::GEOMETRY, {'xmin': ?, 'xmax': ?, 'ymin': ?, 'ymax': ?}, ?,"
            " {'primary': ?}, {'names': {'primary': ?}}, {'primary': ?, 'hierarchy': ?::VARCHAR[]}, ?, ?,"
            " ?::STRUCT(freeform VARCHAR, locality VARCHAR, region VARCHAR)[])",
            [[p["id"], f"POINT ({p['lon']} {p['lat']})", p["lon"], p["lon"], p["lat"], p["lat"], p["confidence"],
              p["name"], p["brand"], p["hierarchy"][-1], p["hierarchy"], p["websites"], p["phones"], p["addresses"]]
             for p in places])
        conn.execute(f"COPY p TO '{path}' (FORMAT parquet)")


@pytest.fixture
def overture_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(overture_places, "DATA_DIR", tmp_path)
    return tmp_path


async def _places(conn, places: list[dict]) -> dict[str, str | None]:
    """見本を取り込んで地点を作り直し、入った地点の 名前 → 群（群を持たなければNone）を返す。"""
    _write_parquet(overture_places.places_path(ROWS.release), places)
    await ingest_source(conn, PROFILE, Source.OVERTURE_PLACE)
    await derive_places.derive(conn)
    return {row["name"]: row["place_group"]
            for row in await conn.fetch("SELECT name, place_group FROM places")}


async def test_each_place_goes_to_the_group_of_its_category(derive_conn, overture_dir):
    """群は分類の道筋のどこかの語で決まる。名所の城は、名所に入れない`historic_site`の下にあっても名所に入る。"""
    samples = {
        "restaurant": (FOOD, "eat_drink"),
        "onsen": (["lifestyle_services", "wellness_service", "public_bath_house", "onsen"], "bath"),
        "bike_rental": (["sports_and_recreation", "recreational_equipment_rental", "bike_rental"], "bicycle"),
        "castle": (["cultural_and_historic", "historic_site", "castle"], "scenic"),
        "hotel": (["lodging", "hotel"], "lodging"),
        "ローソン": (STORE, "convenience"),
    }

    places = [_place(name, LON + i * APART, hierarchy) for i, (name, (hierarchy, _)) in enumerate(samples.items())]

    assert await _places(derive_conn, places) == {
        name: group for name, (_, group) in samples.items()}


async def test_places_outside_the_groups_are_taken_without_a_group(derive_conn, overture_dir):
    """群の語の上の段だけの分類（マンションの多い`historic_site`だけ等）と、どの群にも当たらない分類（駅）は、群を持たない
    地点として入る——地図の立ち寄り先の点には出ず、地点の検索にだけ出る。"""
    places = [
        _place("outside", LON, ["cultural_and_historic", "historic_site"]),
        _place("駅", LON + APART, ["travel_and_transportation", "train_station"]),
        _place("kept", LON - APART, FOOD),
    ]

    assert await _places(derive_conn, places) == {"outside": None, "駅": None, "kept": "eat_drink"}


async def test_places_less_confident_than_the_declared_bound_are_not_taken(derive_conn, overture_dir):
    places = [
        _place("at_bound", LON, FOOD, confidence=ROWS.min_confidence),
        _place("below", LON + APART, FOOD, confidence=ROWS.min_confidence - 0.01),
    ]

    assert await _places(derive_conn, places) == {"at_bound": "eat_drink"}


async def test_places_outside_the_import_area_are_not_taken(derive_conn, overture_dir):
    min_lat = PROFILE.target.bbox[0]
    places = [_place("inside", LON, FOOD), _place("south_of_area", LON, FOOD, lat=min_lat - 0.01)]

    assert await _places(derive_conn, places) == {"inside": "eat_drink"}


async def test_the_same_chain_close_together_in_a_group_becomes_its_most_confident_place(derive_conn, overture_dir):
    """同じ店が出どころごとに表記を変えて少しずれて入っているのを1つにする。別の店（チェーンが違う・分からない・
    群が違う・遠い）は残す。"""
    places = [
        # 表記の揺れ（ハイフン・店名の有無）で20m → 確からしさの高いほうだけ
        _place("セブン-イレブン", LON, STORE, confidence=0.8),
        _place("セブンイレブン 南浦和駅西口店", LON + 20 * M, STORE, confidence=0.95),
        # ブランドの列（英字）と名前（かな）で20m → 1つ
        _place("ファミリーマート 東上野店", LON + APART, STORE, confidence=0.95),
        _place("FM", LON + APART + 20 * M, STORE, brand="FamilyMart", confidence=0.8),
        # 表に無いチェーンはブランドの一致で見る
        _place("Cafe A 1", LON + 2 * APART, FOOD, brand="Cafe A", confidence=0.8),
        _place("Cafe A 2", LON + 2 * APART + 20 * M, FOOD, brand="CAFE A", confidence=0.95),
        # 南北に20m → 1つ
        _place("ミニストップ 1", LON + 7 * APART, STORE, confidence=0.95),
        _place("ミニストップ 2", LON + 7 * APART, STORE, confidence=0.8, lat=LAT + 20 * M_LAT),
        # 同じチェーンで40m → 両方
        _place("ローソン 1", LON + 3 * APART, STORE),
        _place("ローソン 2", LON + 3 * APART + 40 * M, STORE),
        # 違うチェーンで20m（`ローソン`を含む別のチェーン） → 両方
        _place("ローソン 3", LON + 4 * APART, STORE),
        _place("ローソンストア100 3", LON + 4 * APART + 20 * M, STORE),
        # チェーンの分からない店で20m → 両方
        _place("個店1", LON + 5 * APART, FOOD),
        _place("個店2", LON + 5 * APART + 20 * M, FOOD),
        # 同じチェーンで違う群で20m → 両方
        _place("セブン-イレブン ホテル", LON + 6 * APART, ["lodging", "hotel"]),
        _place("セブン-イレブン 店", LON + 6 * APART + 20 * M, STORE),
    ]

    assert set(await _places(derive_conn, places)) == {
        "セブンイレブン 南浦和駅西口店", "ファミリーマート 東上野店", "Cafe A 2", "ローソン 1", "ローソン 2", "ローソン 3",
        "ローソンストア100 3", "個店1", "個店2", "セブン-イレブン ホテル", "セブン-イレブン 店", "ミニストップ 1"}


async def test_each_place_keeps_its_name_without_variations_in_notation(derive_conn, overture_dir):
    """地点の検索が名前を引く形。全角・半角・大文字・空白・ハイフン・中点・ひらがなとカタカナの揺れを除く。"""
    await _places(derive_conn, [_place("セブン-イレブン　新宿・西口のお店 ＣＡＦＥ", LON, FOOD)])

    assert await derive_conn.fetchval("SELECT search_name FROM places") == "セブンイレブン新宿西口ノオ店cafe"


async def test_the_convenience_group_takes_only_convenience_chains(derive_conn, overture_dir):
    """Overture のコンビニの分類には、コンビニでない店・個人の店も入っている。群「コンビニ」はコンビニのチェーンの名前か
    ブランドに当たる店だけで、ほかは群を持たない地点として入る。ほかの群はチェーンを問わない。"""
    kept = [
        _place("ローソン 渋谷店", LON, STORE),
        _place("FM", LON + APART, STORE, brand="FamilyMart"),
    ]
    dropped = [
        _place("ダイソー 渋谷店", LON + 2 * APART, STORE),
        _place("U Co-op", LON + 3 * APART, STORE, brand="Co-op"),
    ]

    assert await _places(derive_conn, [*kept, *dropped, _place("個店", LON - APART, FOOD)]) == {
        "ローソン 渋谷店": "convenience", "FM": "convenience", "ダイソー 渋谷店": None, "U Co-op": None,
        "個店": "eat_drink"}


async def test_a_chain_name_whose_voiced_marks_turned_into_spaces_is_still_the_chain(derive_conn, overture_dir):
    """濁点が空白に化けた名前（「セフ ンイレフ ン」）も、そのチェーンとして入り、隣の同じ店とまとまる。"""
    places = [
        _place("セフ ンイレフ ン相生店", LON, STORE, confidence=0.95),
        _place("セブン-イレブン 相生店", LON + 20 * M, STORE, confidence=0.8),
        _place("テ イリーヤマサ キ 遠い店", LON + APART, STORE),
    ]

    assert await _places(derive_conn, places) == {
        "セフ ンイレフ ン相生店": "convenience", "テ イリーヤマサ キ 遠い店": "convenience"}


async def test_an_atm_in_a_store_is_the_store(derive_conn, overture_dir):
    """店の中の ATM の地点は、名前を店の名前に直す。店の隣にあれば店とまとまり、ATM の地点しか無い店も店として残る。
    店でない所の ATM（コンビニのチェーンに当たらない）は、直した名前で群を持たない地点として入る。"""
    places = [
        _place("セブン銀行ATM セブン-イレブン 渋谷本町1丁目店 共同出張所", LON, STORE, confidence=0.95),
        _place("セブン-イレブン 渋谷本町1丁目店", LON + 10 * M, STORE, confidence=0.8),
        _place("銀行ATM | イーネット ファミリーマート横須賀長井一丁目 共同出張所", LON + APART, STORE),
        _place("イーネットATM ファミリーマート宇佐美246号溝の口【ASD】 共同出張所", LON + 2 * APART, STORE),
        _place("セブン銀行ATM ヤオコー 川口SKIPシティ店 共同出張所", LON + 3 * APART, STORE),
    ]

    assert await _places(derive_conn, places) == {
        "セブン-イレブン 渋谷本町1丁目店": "convenience",
        "ファミリーマート横須賀長井一丁目": "convenience",
        "ファミリーマート宇佐美246号溝の口【ASD】": "convenience",
        "ヤオコー 川口SKIPシティ店": None}


async def test_bike_share_ports_have_no_group(derive_conn, overture_dir):
    """シェアサイクルの貸し場は、貸し自転車の分類に入っていても自転車の群に入らない。貸し場のチェーンの名前の地点と、店先の
    貸し場がコンビニの名前で入った地点が当たる。貸し自転車の店・自転車屋は群に入る。"""
    rental = ["sports_and_recreation", "recreational_equipment_rental", "bike_rental"]
    places = [
        _place("HELLO CYCLING 日暮里南公園", LON, rental),
        _place("千代田区コミュニティサイクル ちよくる A4-04", LON + APART, rental),
        _place("セブンイレブン 荒川南千住3丁目店", LON + 2 * APART, rental),
        _place("レンタサイクル 鎌倉", LON + 3 * APART, rental),
        _place("ワイズロード上野アサゾー", LON + 4 * APART, BIKE_STORE),
    ]

    assert await _places(derive_conn, places) == {
        "HELLO CYCLING 日暮里南公園": None, "千代田区コミュニティサイクル ちよくる A4-04": None,
        "セブンイレブン 荒川南千住3丁目店": None, "レンタサイクル 鎌倉": "bicycle", "ワイズロード上野アサゾー": "bicycle"}


async def test_a_place_without_a_group_goes_to_the_same_chain_with_a_group_close_by(derive_conn, overture_dir):
    """同じ店が別の分類（群に入らない分類）でも入っているのを、群を持つ店へ寄せる。名前の書き方が違っても、チェーンの語で同じ
    チェーンになる（「ワイズロード」と「Y's Road」）。遠い・チェーンが違う・チェーンの分からない地点は残す。"""
    clothing = ["shopping", "fashion_and_apparel_store", "clothing_store"]
    places = [
        _place("ワイズロード渋谷", LON, BIKE_STORE),
        _place("Y's Road 渋谷本館", LON + 20 * M, clothing),
        _place("Y’s Road 横浜", LON + APART, clothing),
        _place("個店", LON + 2 * APART, BIKE_STORE),
        _place("個店 2", LON + 2 * APART + 10 * M, clothing),
    ]

    assert await _places(derive_conn, places) == {
        "ワイズロード渋谷": "bicycle", "Y’s Road 横浜": None, "個店": "bicycle", "個店 2": None}


async def test_places_without_a_group_of_the_same_brand_are_one_only_when_they_are_the_same_kind(derive_conn, overture_dir):
    """群を持たない地点は、同じブランドで30m以内でも、細かい分類が違えば別の施設として残す（モールの同じブランドの映画館と
    銀行）。同じ分類なら、出どころ違いの同じ施設として確からしさの高い1つにまとめる。"""
    cinema = ["arts_and_entertainment", "cinema"]
    bank = ["services_and_business", "financial_service", "bank"]
    places = [
        _place("イオンシネマ", LON, cinema, brand="イオン", confidence=0.9),
        _place("イオン銀行", LON + 10 * M, bank, brand="イオン"),
        _place("イオンシネマ 2", LON + 20 * M, cinema, brand="イオン", confidence=0.7),
    ]

    assert await _places(derive_conn, places) == {"イオンシネマ": None, "イオン銀行": None}


async def test_each_place_keeps_its_address_for_the_outside_map_unless_another_prefecture_is_mixed_in(
        derive_conn, overture_dir):
    """外の地図の検索に渡す住所。市区町村から書かれた残りはそのまま、番地だけの残りは市区町村を頭に付ける。残りに別の都道府県が
    書かれ、市区町村を含まない住所は、別の場所の住所が混ざっている（王子の店に「北区」と「沖縄県那覇市…」）ので持たない。"""
    places = [
        _place("渋谷の店", LON, FOOD, address={"freeform": "渋谷区道玄坂2丁目10-7", "locality": "渋谷区", "region": None}),
        _place("番地だけ", LON + APART, FOOD, address={"freeform": "千駄ヶ谷4丁目26-5", "locality": "渋谷区", "region": "東京都"}),
        _place("県から", LON + 2 * APART, FOOD,
               address={"freeform": "東京都文京区本駒込2-29-14", "locality": "文京区", "region": None}),
        _place("混ざった", LON + 3 * APART, FOOD,
               address={"freeform": "沖縄県那覇市字安里48番地", "locality": "北区", "region": None}),
        _place("住所なし", LON + 4 * APART, FOOD),
    ]

    await _places(derive_conn, places)

    assert {row["name"]: row["address"] for row in await derive_conn.fetch("SELECT name, address FROM places")} == {
        "渋谷の店": "渋谷区道玄坂2丁目10-7", "番地だけ": "東京都渋谷区千駄ヶ谷4丁目26-5", "県から": "東京都文京区本駒込2-29-14",
        "混ざった": None, "住所なし": None}


async def test_a_place_without_a_japanese_name_goes_to_the_japanese_place_with_the_same_contact(derive_conn, overture_dir):
    """同じ場所が言語違いの別の行で入っているのを、日本語の名前の行へ寄せる（六義園の周りの行の形）。ウェブサイト・電話の
    書き方の揺れは同じ連絡先とみなす。遠くの地点とも共有する連絡先・日本語の名前どうし・日本語でない名前どうし・
    違う群・飲食は寄せない。"""
    park = ["sports_and_recreation", "park"]
    hotel = ["lodging", "hotel"]
    site = "https://www.tokyo-park.or.jp/park/format/index031.html"
    places = [
        _place("ろくぎえん", LON, park, websites=[site], phones=["+81339412222"]),
        # 書き方の違う同じウェブサイト・電話で、景色・名所の距離（200m）以内 → 寄る
        _place("ริกุงิเอ็ง", LON + 150 * M, park, websites=["http://tokyo-park.or.jp/park/format/index031.html/"]),
        _place("Rikugien Gardens", LON - 150 * M, park, phones=["03-3941-2222"]),
        # 1km 先の地点も持つ電話（区の公園の窓口） → 残る
        _place("Rikugi Kouen", LON + 10 * M, park, phones=["+81358031252"]),
        _place("六義公園", LON + APART, park, phones=["03-5803-1252"]),
        # 連絡先が無い → 残る
        _place("Rikugien, Komagome", LON + 20 * M, park),
        # 日本語の名前どうし（同じ公園の中の別の場所） → 両方
        _place("ペリー公園", LON + 2 * APART, park, phones=["0468347531"]),
        _place("ペリー記念館", LON + 2 * APART + 50 * M, park, phones=["0468347531"]),
        # 日本語でない名前どうし → 両方
        _place("Sushi Sui", LON + 3 * APART, park, phones=["0356511147"]),
        _place("Ningyocho Iki", LON + 3 * APART + 5 * M, park, phones=["0356511147"]),
        # 違う群 → 両方
        _place("Hotel Hamarikyu", LON + 4 * APART, hotel, phones=["0335410200"]),
        _place("浜離宮恩賜庭園", LON + 4 * APART + 5 * M, park, phones=["0335410200"]),
        # 泊まるも、群の距離（30m）以内なら寄る
        _place("Okunikko Kogen Hotel", LON + 5 * APART, hotel, phones=["0288622121"]),
        _place("奥日光高原ホテル", LON + 5 * APART + 10 * M, hotel, phones=["0288622121"]),
        # 飲食 → 両方
        _place("Bar Izayoi", LON + 6 * APART, FOOD, phones=["0443228660"]),
        _place("Bar 十六夜", LON + 6 * APART + 10 * M, FOOD, phones=["0443228660"]),
    ]

    assert set(await _places(derive_conn, places)) == {
        "ろくぎえん", "Rikugi Kouen", "六義公園", "Rikugien, Komagome", "ペリー公園", "ペリー記念館", "Sushi Sui",
        "Ningyocho Iki", "Hotel Hamarikyu", "浜離宮恩賜庭園", "奥日光高原ホテル", "Bar Izayoi", "Bar 十六夜"}
