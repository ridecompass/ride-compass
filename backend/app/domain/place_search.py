"""地点の検索（入力した文字列から、出発地・経由地・目的地にできる地点の候補を引く）の語彙と答えの形。

候補は種類（何から引いたか。住所の区画の表か、地点の表の施設か）と、当たった段（住所ならどの段の区画に当たったか。
施設は施設そのものの点）を持つ。種類を足すときは
`PlaceKind`と`PLACE_KIND_LABELS`へ1つずつ足し、口と答えの形は変えない。表示名は語彙と同じ並びで
生成物（`vocabulary.ts`）が画面へ届ける。

住所は住所の区画の表（`domain/address_area.py`）から引く。
"""

from typing import Annotated, Literal
from urllib.parse import quote

from pydantic import StringConstraints

from app.domain.geo import Latitude, Longitude
from app.domain.strict_model import StrictModel

#: 候補の種類。
PlaceKind = Literal["address", "facility"]
PLACE_KIND_LABELS: dict[PlaceKind, str] = {"address": "住所", "facility": "施設"}

#: 当たった段（粗い→細かい）。`block`の前までが住所の区画の段（`domain/address_area.py: ADDRESS_AREA_LEVELS`）。
#: `block`は区画の中の街区（住居表示の区域）か地番（それ以外の区域）で、番地まで打った入力だけが当たる
#: （`domain/address_area.py: BLOCK_KINDS`）。最後の`point`は施設そのものの点（範囲の代表点ではない）。
PlaceMatchLevel = Literal["prefecture", "city", "ward", "oaza", "aza", "block", "point"]
PLACE_MATCH_LEVEL_LABELS: dict[PlaceMatchLevel, str] = {
    "prefecture": "都道府県",
    "city": "市区町村",
    "ward": "区",
    "oaza": "大字・町",
    "aza": "字・丁目",
    "block": "街区・地番",
    "point": "地点",
}

#: 入力の長さの上限。住所の1行（都道府県から号まで・建物名つき）が収まる長さ。
_PLACE_QUERY_MAX_LENGTH = 100
PlaceQuery = Annotated[str, StringConstraints(min_length=1, max_length=_PLACE_QUERY_MAX_LENGTH)]

#: 入力の続き（打ちかけの語を頭に持つ住所）を候補に足す最短の長さ（空白を除いた文字数）。画面が打ちかけで引き始める
#: 長さも同じ。根拠は docs/modules/backend/place-search.md「引き方」。
PLACE_PREDICTION_MIN_LENGTH = 1
#: 候補の数の上限（住所と施設を合わせて。地図の印の数もこれで決まる）。住所（続きの候補を含む）と施設は、それぞれこの件数まで
#: 引いてから`allot_candidates`で配分する。
PLACE_PREDICTION_LIMIT = 20
#: 画面が、打つのが止まってから引くまでの間。打ち続けたときの1分あたりの回数の最大がこれで決まり、口の回数制限
#: （`config.py: place_search_rate_limit_per_minute`）はそれに当たらないようにこの値から導く。
PLACE_PREDICTION_DELAY_SECONDS = 0.4

#: 地点の検索の住所（`domain/address_area.py`）と辺りの元データの出典。アドレス・ベース・レジストリは CC BY 4.0、e-Stat の境界は
#: 政府標準利用規約（第2.0版）で、どちらも出典と加工した旨を書く。街区レベル位置参照情報は位置参照情報利用約款の第2条で、
#: 加工したものにも出典を書く（docs/architecture/data-sources.md）。
ADDRESS_AREA_ATTRIBUTIONS: tuple[str, ...] = (
    '住所: 「<a href="https://www.digital.go.jp/policies/base_registry_address/" target="_blank" rel="noreferrer">'
    "アドレス・ベース・レジストリ</a>」[デジタル庁]の町字マスター・住居表示の街区マスター・位置参照拡張を加工して作成"
    ' (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>)',
    '住所の境界: 出典 <a href="https://www.e-stat.go.jp/" target="_blank" rel="noreferrer">政府統計の総合窓口(e-Stat)</a>。'
    "「令和2年国勢調査 小地域(町丁・字等別)境界データ」[総務省統計局]を加工して作成",
    '住所の地番: 「<a href="https://nlftp.mlit.go.jp/isj/" target="_blank" rel="noreferrer">街区レベル位置参照情報</a>」'
    "[国土交通省]を加工して作成",
)


class PlaceCandidate(StrictModel):
    """検索の候補1件。住所なら`name`は都道府県から当たった段までをつないだ表示名で、位置はその段の代表点（街区・地番は
    その街区・地番の代表点）。
    施設なら施設の名前と、施設の位置。"""

    kind: PlaceKind
    level: PlaceMatchLevel
    name: str
    #: 施設の辺り（市区町村から字・丁目まで。「川口市元郷四丁目」）。同じ名前の店を見分ける。住所は表示名がその住所
    #: なので持たない。施設でも、地点の表の行が辺りを持たなければ持たない（`derived_models.py: PlaceRow.area`）。
    area: str | None
    latitude: Latitude
    longitude: Longitude


class PlaceSearchResult(StrictModel):
    """当たった候補（`PLACE_PREDICTION_LIMIT`件まで。配分は`allot_candidates`）。並びは住所 → 施設。住所の中の並びは
    `domain/address_area.py: address_hit_order_sql`、施設の中の並びは当たり方（`domain/stop_place.py: match_rank_sql`）→ 近さ。
    入力の一部にだけ当たった住所（「小杉湯」の「小杉」）は候補にしない。何も当たらなければ空。"""

    candidates: list[PlaceCandidate]


class PlaceArea(StrictModel):
    """位置の辺り（地図で置いた地点・現在地の詳しくに出す）。"""

    #: 位置を含む小地域の境界の、市区町村から町丁・字までの名前（施設の辺りと同じ形。「新宿区西新宿二丁目」）。
    #: 名前を持つ境界に含まれなければ持たない（海の上・取り込んだ境界の外・名前の無い境界の中）。
    area: str | None


def allot_candidates(addresses: list[PlaceCandidate], facilities: list[PlaceCandidate]) -> list[PlaceCandidate]:
    """住所と施設の候補（それぞれ並び順で`PLACE_PREDICTION_LIMIT`件まで）を、合わせて`PLACE_PREDICTION_LIMIT`件に配分する。
    両方が半分以上あれば半分ずつ（住所が奇数の分を取る）、片方が半分より少なければ、もう片方が空いた分を埋める。"""
    facility_count = min(len(facilities), max(PLACE_PREDICTION_LIMIT // 2, PLACE_PREDICTION_LIMIT - len(addresses)))
    address_count = min(len(addresses), PLACE_PREDICTION_LIMIT - facility_count)
    return [*addresses[:address_count], *facilities[:facility_count]]


#: 外の地図へ渡す名前の長さの上限。地点の名前（Overture の名前・文化財の所有者の名前）が収まる長さ。
_PLACE_NAME_MAX_LENGTH = 200
PlaceName = Annotated[str, StringConstraints(min_length=1, max_length=_PLACE_NAME_MAX_LENGTH)]

#: 外の地図の店の検索（Google の Maps URLs の`search`。キーも料金も要らない）。
_MAPS_SEARCH_URL = "https://www.google.com/maps/search/?api=1&query="


def maps_search_url(name: str, where: str) -> str:
    """名前と所在（住所か辺り）で店を開く外の地図のリンク。公式の文書（Maps URLs）が店を開く形として勧める「名前,住所」。
    名前と座標を1つの検索語にすると、Google は座標を効かせず名前だけで引き、見ている辺りの同じ名前の別の店を開く。"""
    return _MAPS_SEARCH_URL + quote(f"{name},{where}", safe="")


class PlaceLink(StrictModel):
    """地図の点の名前から開く外の地図のリンク。"""

    #: 点の所在（住所か辺り）が分からなければ持たない（理由は`maps_search_url`）。
    url: str | None
