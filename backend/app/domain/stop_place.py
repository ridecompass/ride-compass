"""地点（名前のある場所）の群・チェーン・名前の揃え方と、地点を群へ入れる判断・地点の検索で打った語を群やチェーンとして
読む判断・検索に出さない分類。

地点の表（`infrastructure/derived_models.py: PlaceRow`）は名前のある地点を全部持ち、立ち寄り先（食べる・飲む・入浴・自転車・
景色・名所・泊まる・コンビニ・寺社）はそのうち群を持つ行である。地点の生データの列の読み替えは
`infrastructure/source_models.py: OVERTURE_PLACES_SOURCE_SQL`・`BUNKA_HERITAGES_SOURCE_SQL`が持ち、ここへは読み替えた列で
届く。群へ入れ、近くの同じ店をまとめるのは派生の段（`batch/derive_places.py`）である。

寺社・宗教施設と、補給の点のうちコンビニ以外（自販機・トイレ・給水・駐輪場）に当たる分類は、どの群の語にも
入れない——地図の点では、寺社は文化財の一覧から、補給の点は OpenStreetMap から出す（1つの種類を2つの出どころから出さない）。
その分類の Overture の地点は、群を持たない地点として検索にだけ出る。補給の点のコンビニは、群「コンビニ」の行から出す
（`infrastructure/point_tile_layers.py`の`poi`）。
"""

import re
import unicodedata
from dataclasses import dataclass
from enum import StrEnum

from app.domain.address_area import HYPHEN_CHARACTERS
from app.domain.material_sql import sql_literals


class StopPlaceGroup(StrEnum):
    """立ち寄り先の群。地図のチップで選ぶ単位で、点のタイルの属性`group`の値。"""

    EAT_DRINK = "eat_drink"
    BATH = "bath"
    BICYCLE = "bicycle"
    SCENIC = "scenic"
    LODGING = "lodging"
    CONVENIENCE = "convenience"
    #: 国の指定・登録の文化財の建造物を持つ寺社（下の`temple_shrine_owner_sql`）。
    TEMPLE_SHRINE = "temple_shrine"


#: Overture の分類（`taxonomy.hierarchy`。上の段から下の段への語の並び）の語 → 群。道筋に語が1つでも
#: あればその群で、上の行から先に当たった群に入れる。語は細かい段を名指す——上の段を名指すと、下に
#: 立ち寄り先でない分類を抱える（`lodging`だけの行は寮・住所が多く、`historic_site`はマンションの名前が
#: 多く、`spa`はエステ・マッサージ）。どの群の語も持たない地点は、群を持たない地点になる。
#: シェアサイクルの貸し場は群に入れない——自分の自転車で走る人の立ち寄り先にならず、都市部では自転車屋の数倍ある。配布の
#: 貸し場の分類（`bike_sharing_location`）にはほとんど入らず、貸し自転車（`bike_rental`）に入るので、分類でなくチェーン
#: （`CHAIN_WORDS`の`Chain.bike_share`）で見分ける（`place_group_sql`）。公式の分類の一覧: https://docs.overturemaps.org/guides/places/
OVERTURE_GROUP_WORDS: tuple[tuple[StopPlaceGroup, frozenset[str]], ...] = (
    (StopPlaceGroup.EAT_DRINK, frozenset({"food_and_drink"})),
    (StopPlaceGroup.BATH, frozenset({"public_bath_house", "sauna", "hot_springs"})),
    (StopPlaceGroup.BICYCLE, frozenset({"bike_store", "bike_repair_maintenance", "bike_rental"})),
    (StopPlaceGroup.SCENIC, frozenset({
        "park", "garden", "lake", "waterfall", "mountain", "beach", "castle", "observatory", "museum",
        "nature_reserve"})),
    (StopPlaceGroup.LODGING, frozenset({
        "hotel", "hostel", "inn", "bed_and_breakfast", "campground", "resort", "lodge", "cabin", "cottage"})),
    (StopPlaceGroup.CONVENIENCE, frozenset({"convenience_store"})),
)

#: 群 → 打てばその群の店を近い順に出す語。利用者はどの群があるかを知らないので、群の名前と、群そのものを指す
#: 言い換えを広く受ける。群の一部の種類だけを指す語（「公園」「ホテル」「神社」「カフェ」）は入れない——入れると、
#: 群の別の種類の店（「公園」で博物館、「カフェ」でラーメン屋）が近い順に先に出る。その語は店の名前で引く。
PLACE_GROUP_WORDS: dict[StopPlaceGroup, tuple[str, ...]] = {
    StopPlaceGroup.CONVENIENCE: ("コンビニ", "コンビニエンスストア", "convenience", "convenience store", "konbini"),
    StopPlaceGroup.BATH: (
        "銭湯", "銭湯・温泉", "温泉", "天然温泉", "日帰り温泉", "スーパー銭湯", "スパ銭", "風呂", "お風呂", "入浴",
        "日帰り入浴", "浴場", "公衆浴場", "健康ランド", "サウナ", "sento", "onsen", "sauna"),
    StopPlaceGroup.EAT_DRINK: ("飲食店", "飲食", "食事", "ご飯", "ごはん", "グルメ", "レストラン"),
    StopPlaceGroup.LODGING: ("宿", "宿泊", "宿泊施設", "泊まる", "泊まる所", "泊まれる所"),
    StopPlaceGroup.BICYCLE: ("自転車", "自転車屋", "自転車店", "サイクルショップ", "自転車修理"),
    StopPlaceGroup.SCENIC: ("景色・名所", "景色", "絶景", "名所", "観光地", "観光スポット", "景勝地", "見どころ"),
    StopPlaceGroup.TEMPLE_SHRINE: ("寺社", "社寺", "神社仏閣", "寺社仏閣"),
}

#: ひらがなとカタカナ（同じ並び）。名前の揃え方で、ひらがなをカタカナへ寄せる——チェーンの語・群の語はカタカナで書く。
_HIRAGANA = "".join(chr(code) for code in range(ord("ぁ"), ord("ゖ") + 1))
_KATAKANA = "".join(chr(ord(kana) + 0x60) for kana in _HIRAGANA)
_HIRAGANA_TO_KATAKANA = str.maketrans(_HIRAGANA, _KATAKANA)
#: 名前の揃え方で、空白のほかに除く文字（中点・ハイフンの類。長音は残す——「スーパー」が「スパ」にならない）。ハイフンの類は
#: 住所の揃え方と同じ集合（`domain/address_area.py: HYPHEN_CHARACTERS`。末尾が半角のハイフンで、文字類の末尾に置く）。
_NAME_IGNORED_CHARACTERS = f"・･{HYPHEN_CHARACTERS}"
_NAME_IGNORED_SQL = f"[[:space:]{_NAME_IGNORED_CHARACTERS}]"
_NAME_IGNORED = re.compile(f"[\\s{_NAME_IGNORED_CHARACTERS}]")


def normalized_sql(text_expr: str) -> str:
    """名前の表記の揺れ（全角・半角・大文字・空白・ハイフンの類・中点・ひらがなとカタカナ）を除いた形を出す式。"""
    return (f"translate(lower(regexp_replace(normalize({text_expr}, NFKC), '{_NAME_IGNORED_SQL}', '', 'g')),"
            f" '{_HIRAGANA}', '{_KATAKANA}')")


def normalized_form(text: str) -> str:
    """`normalized_sql`と同じ揃え方（打った語を群の語・チェーンの語と比べる・語の書き方を確かめる）。"""
    return _NAME_IGNORED.sub("", unicodedata.normalize("NFKC", text)).lower().translate(_HIRAGANA_TO_KATAKANA)


_GROUP_BY_WORD: dict[str, StopPlaceGroup] = {
    normalized_form(word): group for group, words in PLACE_GROUP_WORDS.items() for word in words}


def queried_group(query: str) -> StopPlaceGroup | None:
    """入力が群の語（`PLACE_GROUP_WORDS`。表記の揺れ——全角・半角・大文字・空白・中点・ひらがなとカタカナ——を除いて比べる）
    なら、その群。語を含むだけの入力（「大江戸温泉物語」）は店の名前でありうるので、群として読まない。"""
    return _GROUP_BY_WORD.get(normalized_form(query))


#: 同じ群・同じチェーンの地点を1つにまとめる距離（地面の m）。同じ店が出どころごとに少しずれた位置で
#: 重なって入っているのを1つにする。チェーンの分からない地点は別々の店として扱い、まとめない。群を持たない地点が、同じ
#: チェーンでこの距離の中の群を持つ地点と重なれば、群を持つほうへ寄せる（分類の違う出どころが同じ店を別の行で入れている）。
MERGE_RADIUS_M = 30.0

#: 名前に日本語の文字（かな・漢字）が無い地点を、同じ連絡先を持つ日本語の名前の地点へ寄せる群と、寄せる距離（地面の m）。
#: 同じ場所が出どころの中で言語違いの別の行（Facebook のページ等）として重なって入っているのを1つにする。Overture の地点には
#: 重なりを結ぶ ID も言語ごとの名前も無い。飲食は入れない——同じ連絡先を持つ近くの店は、同じビル・同じ会社の別の店が多い。
#: 景色・名所は場所が広く、同じ公園の行が100m以上離れて入る。値の根拠は docs/modules/backend/static-road-attributes.md「立ち寄り先」。
CONTACT_MERGE_RADIUS_M: dict[StopPlaceGroup, float] = {
    StopPlaceGroup.SCENIC: 200.0,
    StopPlaceGroup.LODGING: MERGE_RADIUS_M,
    StopPlaceGroup.BATH: MERGE_RADIUS_M,
    StopPlaceGroup.BICYCLE: MERGE_RADIUS_M,
}

@dataclass(frozen=True)
class Chain:
    """チェーン1つ。名前かブランドが`words`のどれかを含めばそのチェーンとみなす（`chain_sql`）。語は名前の揃え方
    （`normalized_sql`）にかけてから当てるので、書き方は問わない。"""

    key: str
    words: tuple[str, ...]
    #: 群「コンビニ」に入れる店か。Overture の`convenience_store`の地点は、このチェーンの店だけが群「コンビニ」に入る。
    convenience: bool = False
    #: シェアサイクルの貸し場か。群に入れない（`OVERTURE_GROUP_WORDS`の上のコメント）。
    bike_share: bool = False


#: チェーンと、名前かブランドに含まれていればそのチェーンとみなす語。上の行から
#: 先に当たったチェーンに入れる（`ローソンストア100`を`ローソン`より先に置く）。ブランドの列は出どころによって
#: 空か表記がばらばら（「FamilyMart」「ローソン Lawson Japan」「ワイズロード　神戸店」）で、同じ店が「セブン-イレブン」と
#: 「セブンイレブン 南浦和駅西口店」、「ワイズロード渋谷」と「Y's Road 渋谷本館」のように入るので、表記の揺れをここで寄せる。
#: ほかのチェーンはブランドの一致で見る。地点の検索は、入力がこの語なら、そのチェーンの店を近い順に出す（`queried_chain`）。
#: 旧名（サンクス・サークルK・セーブオン等）は、看板を替えた店の古い地点が今の店の隣に残っているので、今のチェーンへ寄せる。
#:
#: 群の決め直し（`place_group_sql`）は行の`Chain.convenience`・`Chain.bike_share`を読む。Overture の`convenience_store`には、
#: 100円ショップ・ドラッグストア・小さなスーパー・個人の商店・駐車場等も入っている。語は関東の地点（コンビニは 2026-09-23.1、ほかは 2026-10-21.0）の名前から足した。1件ずつの
#: 打ち間違い（「ロ−ソン」等）は足さない。シェアサイクルの貸し場はコンビニの店先にも置かれ、店の名前の貸し場がある
#: （「HELLO CYCLING セブンイレブン新御徒町駅前店」）ので、貸し場のチェーンをコンビニより先に置く。
CHAIN_WORDS: tuple[Chain, ...] = (
    Chain("hello_cycling", ("hellocycling", "ハローサイクリング"), bike_share=True),
    Chain("docomo_bike_share", ("ドコモバイクシェア", "docomobikeshare", "チヨクル"), bike_share=True),
    Chain("baybike", ("baybike",), bike_share=True),
    Chain("luup", ("luup",), bike_share=True),
    Chain("daichari", ("ダイチャリ",), bike_share=True),
    Chain("charichari", ("チャリチャリ", "charichari"), bike_share=True),
    Chain("harenohi_cycle", ("ハレノヒサイクル",), bike_share=True),
    Chain("suicle", ("suicle", "スイクル"), bike_share=True),
    # 事業者の名前の無い貸し場の一般名（区・市の「千代田区コミュニティサイクル」「港区自転車シェアリング」等）。事業者を
    # 決められないので、事業者の名前のチェーンより後ろに置く。
    Chain("bike_share", ("コミュニティサイクル", "自転車シェアリング", "シェアサイクル", "bikeshare"), bike_share=True),
    # 引用符は NFKC で揃わない（「Y's Road」と「Y’s Road」がどちらも入る）。
    Chain("ys_road", ("ワイズロード", "y'sroad", "y’sroad", "ysroad")),
    Chain("seven_eleven", ("セブンイレブン", "7eleven", "seveneleven"), convenience=True),
    Chain("familymart", (
        "ファミリーマート", "familymart", "ファミマ", "サンクス", "サークルk", "circlek", "サークルケイ", "サークルケー",
        "ココストア", "エーエムピーエム"), convenience=True),
    Chain("lawson_store100", ("ローソンストア100", "lawsonstore100", "ストア100", "store100", "ショップ99"), convenience=True),
    Chain("natural_lawson", ("ナチュラルローソン", "naturallawson"), convenience=True),
    Chain("lawson", ("ローソン", "lawson", "セーブオン"), convenience=True),
    Chain("ministop", ("ミニストップ", "ministop"), convenience=True),
    # ヤマザキデイリーストア・ニューヤマザキデイリーストアは同じ会社の旧い看板。
    Chain("daily_yamazaki", ("デイリーヤマザキ", "dailyyamazaki", "デイリーストア"), convenience=True),
    Chain("yamazaki_shop", ("ヤマザキショップ", "yショップ"), convenience=True),
    Chain("newdays", ("ニューデイズ", "newdays"), convenience=True),
    Chain("seicomart", ("セイコーマート", "seicomart"), convenience=True),
    Chain("three_f", ("スリーエフ",), convenience=True),
    Chain("poplar", ("ポプラ",), convenience=True),
    Chain("seikatsu_saika", ("生活彩家",), convenience=True),
    Chain("community_store", ("コミュニティストア",), convenience=True),
    Chain("mon_mart", ("モンマート",), convenience=True),
    Chain("hot_spar", ("ホットスパー",), convenience=True),
    Chain("rieven_house", ("リーベンハウス", "rievenhouse"), convenience=True),
    # 駅の売店。
    Chain("kiosk", ("キヨスク", "kiosk"), convenience=True),
    Chain("bellmart", ("ベルマート", "bellmart"), convenience=True),
    Chain("plusta", ("plusta",), convenience=True),
    Chain("tomony", ("トモニー",), convenience=True),
    Chain("toks", ("toks",), convenience=True),
    Chain("odakyu_shop", ("odakyushop", "odakyumart"), convenience=True),
)

CONVENIENCE_CHAINS: frozenset[str] = frozenset(chain.key for chain in CHAIN_WORDS if chain.convenience)
BIKE_SHARE_CHAINS: frozenset[str] = frozenset(chain.key for chain in CHAIN_WORDS if chain.bike_share)

#: 地点の検索に出さない分類（Overture の`taxonomy.hierarchy`の語。道筋のどの段に当たっても出さない）。店の中の機械・
#: 付属物が店の名前で入っていて、同じ場所の店の二重になる（関東の 2026-10-21.0 で`rental_kiosk`は「ライフ石神井公園店」等
#: 約6.2万行、`atm`約2.6万行、`parking`は「ウエルシア葛飾亀有店」等約1.8万行、`package_locker`約1万行）。地点の表には
#: 入れたまま検索の文で外すので、変えても派生の作り直しは要らない。
SEARCH_EXCLUDED_CATEGORIES: frozenset[str] = frozenset({"rental_kiosk", "atm", "parking", "package_locker"})

#: 濁点・半濁点の付いたかな → 外した形。チェーンの語は外した形どうしで当てる——濁点が空白に化けた名前
#: （「セフ ンイレフ ン」。元の文字で濁点の場所が空白になっていて、正規化では戻らない）があるため。
_VOICED_KANA = "ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポヴ"
_UNVOICED_KANA = "カキクケコサシスセソタチツテトハヒフヘホハヒフヘホウ"
_DEVOICE = str.maketrans(_VOICED_KANA, _UNVOICED_KANA)


def match_rank_sql(group: str, queried_group: str, chain: str, queried_chain: str, name: str, query: str) -> str:
    """地点の検索で、施設が入力に当たった順位の式（小さいほど先）。群`group`が入力の群`queried_group`の店か、チェーン`chain`が
    入力のチェーン`queried_chain`の店 → 名前`name`（`normalized_sql`の形）が入力`query`（同じ形）と同じ → 入力で始まる →
    入力を含む。"""
    return (f"CASE WHEN {group} = {queried_group} OR {chain} = {queried_chain} THEN 0 WHEN {name} = {query} THEN 1"
            f" WHEN starts_with({name}, {query}) THEN 2 ELSE 3 END")


def japanese_name_sql(name_expr: str) -> str:
    """名前に日本語の文字（ひらがな・カタカナ・半角カナ・漢字）があるかの式。"""
    return f"({name_expr} ~ '[ぁ-ゟ゠-ヿｦ-ﾟ㐀-䶿一-鿿々〆]')"


def contacts_sql(websites_expr: str, phones_expr: str) -> str:
    """地点の連絡先（ウェブサイト・電話。文字列の配列か NULL）を、1つずつ比べられる形の行に出す副問い合わせ
    （列`contact`）。ウェブサイトは小文字にして`http(s)://`・`www.`・末尾の`/`を除き、電話は数字だけにして頭の国番号を0にする
    （配布には`+81339412222`と`03-3941-2222`の両方の書き方がある）。"""
    website = "regexp_replace(lower(trim(w)), '^https?://(www\\.)?|^www\\.|/+$', '', 'g')"
    phone = "regexp_replace(regexp_replace(t, '[^0-9]', '', 'g'), '^81', '0')"
    return (f"SELECT 'w:' || {website} AS contact FROM unnest({websites_expr}) w WHERE {website} <> ''"
            f" UNION SELECT 't:' || {phone} FROM unnest({phones_expr}) t WHERE {phone} <> ''")


def store_name_sql(name_expr: str) -> str:
    """店の中の ATM の地点の名前（「セブン銀行ATM セブン-イレブン ○○店 共同出張所」「銀行ATM | イーネット
    ファミリーマート○○ 共同出張所」）を、中にある店の名前へ直す式。ほかの名前はそのまま。"""
    return (f"regexp_replace({name_expr},"
            " '^(?:(?:セブン)?銀行|イーネット)(?:ATM)?\\s*(?:\\|\\s*イーネット)?\\s*(.*?)\\s*共同出張所$', '\\1')")


def chain_text_sql(normalized_expr: str) -> str:
    """チェーンの語を当てる形（`normalized_sql`で正規化した式から、濁点・半濁点を外した形）を出す式。"""
    return f"translate({normalized_expr}, '{_VOICED_KANA}', '{_UNVOICED_KANA}')"


def _chain_word_form(text: str) -> str:
    """チェーンの語を当てる形（名前の揃え方から濁点・半濁点を外した形。`chain_text_sql`と同じ）。"""
    return normalized_form(text).translate(_DEVOICE)


#: ブランドから作るチェーンの鍵の頭（`CHAIN_WORDS`の鍵と混ざらないようにする）。
BRAND_CHAIN_PREFIX = "brand:"


def chain_sql(name: str, brand: str) -> str:
    """地点のチェーンを出す式。`name`・`brand`は`chain_text_sql`の形の式（ブランドはNULLがある）。
    `CHAIN_WORDS`に当たらなければ`BRAND_CHAIN_PREFIX`を頭に付けたブランド、ブランドも無ければNULL。"""
    whens = " ".join(
        f"WHEN {' OR '.join(f'strpos({text}, {sql_literals([_chain_word_form(word)])}) > 0' for text in (name, brand) for word in chain.words)} THEN {sql_literals([chain.key])}"
        for chain in CHAIN_WORDS)
    return f"CASE {whens} ELSE '{BRAND_CHAIN_PREFIX}' || nullif({brand}, '') END"


def place_group_sql(group: str, chain: str) -> str:
    """分類から決めた群`group`（`overture_group_sql`）とチェーン`chain`（`chain_sql`）から、地点の群を決め直す式。
    シェアサイクルの貸し場のチェーンと、自転車の群に入ったコンビニのチェーン（店先の貸し場）は群を持たない。群「コンビニ」は
    `CONVENIENCE_CHAINS`の店だけで、ほかは群を持たない。どれでもなければ`group`のまま（NULLを含む）。"""
    convenience = sql_literals(sorted(CONVENIENCE_CHAINS))
    return (f"CASE WHEN {chain} IN ({sql_literals(sorted(BIKE_SHARE_CHAINS))}) THEN NULL"
            f" WHEN {group} = '{StopPlaceGroup.BICYCLE}' AND {chain} IN ({convenience}) THEN NULL"
            f" WHEN {group} = '{StopPlaceGroup.CONVENIENCE}' AND ({chain} IS NULL OR {chain} NOT IN ({convenience})) THEN NULL"
            f" ELSE {group} END")


_CHAIN_BY_WORD: dict[str, str] = {
    _chain_word_form(word): chain.key for chain in reversed(CHAIN_WORDS) for word in chain.words}


def queried_chain(query: str) -> str | None:
    """入力がチェーンの語（`CHAIN_WORDS`。名前の揃え方と濁点を除いて比べる）なら、そのチェーン。語を含むだけの入力
    （「ワイズロード渋谷」）はチェーンとして読まない（名前で引く）。"""
    return _CHAIN_BY_WORD.get(_chain_word_form(query))


def search_excluded_sql(categories: str) -> str:
    """地点の分類の道筋`categories`（文字列の配列の式。NULLは分類を持たない地点）が、検索に出さない分類に当たるかの式。"""
    return f"coalesce({categories} && ARRAY[{sql_literals(sorted(SEARCH_EXCLUDED_CATEGORIES))}]::varchar[], false)"


#: 住所の文字列の中の都道府県の形。
_PREFECTURE_PATTERN = "(東京都|北海道|京都府|大阪府|[一-龥]{2,3}県)"


def address_sql(region: str, locality: str, freeform: str) -> str:
    """住所の都道府県・市区町村・残り（都道府県・市区町村は無ければ空の文字列、残りは無ければ NULL）から、外の地図の
    検索に渡す住所を出す式。残りに都道府県が書かれていて市区町村を含まない住所は、別の場所の住所が混ざっている
    （「北区」と「沖縄県那覇市字安里48番地」）ので NULL。
    残りが都道府県か市区町村から書かれていれば残りだけ、そうでなければ都道府県・市区町村・残りをつなぐ。残りが無ければ NULL。"""
    return (f"CASE WHEN {freeform} IS NULL THEN NULL"
            f" WHEN {freeform} ~ '{_PREFECTURE_PATTERN}'"
            f" THEN CASE WHEN {locality} <> '' AND strpos({freeform}, {locality}) = 0 THEN NULL ELSE {freeform} END"
            f" WHEN {locality} <> '' AND starts_with({freeform}, {locality}) THEN {freeform}"
            f" ELSE {region} || {locality} || {freeform} END")


def overture_group_sql(categories: str) -> str:
    """分類の道筋（文字列の配列の式。NULLは分類を持たない地点）から群を出す式。どの群にも当たらなければNULL。"""
    whens = " ".join(
        f"WHEN {categories} && ARRAY[{sql_literals(sorted(words))}]::varchar[] THEN '{group}'"
        for group, words in OVERTURE_GROUP_WORDS)
    return f"CASE {whens} END"


#: 同じ所有者の文化財の建物を1つの寺社にまとめる距離（地面の m）。境内に散らばる建物（本堂・山門・別院）は1つにし、
#: 同じ名前の別の寺社・離れた奥之院は分ける。値の根拠は docs/modules/backend/static-road-attributes.md「立ち寄り先」。
HERITAGE_MERGE_RADIUS_M = 1000.0

#: 所有者の名前がこの語で終われば寺社。所有者の欄が寺社を名指すのは、法人の名前が寺社そのものの名前だから。
#: キリスト教の教会・教団・教区と、新しい宗教団体（「〜教」「〜殿」等）はどれでも終わらない。
TEMPLE_SHRINE_SUFFIXES: tuple[str, ...] = (
    "寺", "院", "神社", "大社", "神宮", "宮", "社", "稲荷", "八幡", "権現", "坊", "庵", "斎", "廟")

#: 寺社の語で終わっても寺社でない名前の終わり。
NOT_TEMPLE_SHRINE_SUFFIXES: tuple[str, ...] = ("病院", "医院", "学院", "修道院", "美術院", "研究院")

#: 寺社の語で終わっても、これを含めば寺社でない（学校法人○○学院・株式会社○○社・特定非営利活動法人○○寺 等）。
#: 宗教法人の印は名前から先に外す（`owner_name_sql`）。
NOT_TEMPLE_SHRINE_WORDS: tuple[str, ...] = ("法人", "会社")


def owner_lines_sql(owners_expr: str) -> str:
    """文化財の所有者の欄を、1人ずつの行に分ける式（集合を返す）。複数の所有者は改行か読点で並ぶ。"""
    return f"regexp_split_to_table({owners_expr}, '[\\n、,，]')"


def owner_name_sql(owner_expr: str) -> str:
    """所有者の欄の1人ぶんから、頭の宗教法人の印（「宗教法人」「（宗教法人）」）と末尾の括弧書き（「（豊川）」）を除いた名前の式。"""
    # 空白には全角の空白も入る（「宗教法人　日本基督教団」）。
    trimmed = f"regexp_replace({owner_expr}, '^[[:space:]　]+|[[:space:]　]+$', '', 'g')"
    stripped = f"regexp_replace({trimmed}, '^[（(]?宗教法人[）)]?[[:space:]　]*', '')"
    return f"regexp_replace({stripped}, '[[:space:]　]*[（(][^）)]*[）)]$', '')"


def temple_shrine_owner_sql(name_expr: str) -> str:
    """`owner_name_sql`の名前が寺社の名前かの式。"""
    suffixes = "|".join(TEMPLE_SHRINE_SUFFIXES)
    not_suffixes = "|".join(NOT_TEMPLE_SHRINE_SUFFIXES)
    not_words = "|".join(NOT_TEMPLE_SHRINE_WORDS)
    return (f"({name_expr} ~ '({suffixes})$' AND {name_expr} !~ '({not_suffixes})$'"
            f" AND {name_expr} !~ '{not_words}')")
