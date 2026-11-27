"""地図に出すものの最上位の束ね方。

所属は**種別**から決まる——レイヤーごとに所属を書くと、1つ足すたびに書き忘れても型が通る。
費用の軸のレンズはここに載らない（管理APIで書いた費用の軸の定義から実行時に決まる）。
"""

from collections import Counter
from collections.abc import Iterable
from typing import Literal, NamedTuple, get_args

from app.domain.landcover import LANDCOVER_TILE_MIN_ZOOM
from app.domain.msm_grid import MSM_GRID_MIN_ZOOM
from app.domain.place_search import ADDRESS_AREA_ATTRIBUTIONS
from app.domain.primary_attributes import PRIMARY_ATTRIBUTES, PRIMARY_ATTRIBUTES_BY_ID
from app.domain.registry import DisplayAxisSpec
from app.domain.region import ROAD_SURFACE_TILE_MIN_ZOOM, ROAD_TILE_MIN_ZOOM
from app.domain.weather_elements import (
    MSM_FORECAST_HOURS,
    WEATHER_ELEMENTS,
    WEATHER_LAYER_GROUPS,
    FrameRuleKind,
    forecast_reach,
    reach_text,
)


class OverlayGroup(NamedTuple):
    key: str
    label: str
    #: 「表示」の一覧に、並びの先頭から最初に並べる項目の数。残りは利用者がこの群で選んで足す。
    initial_items: int


class LayerCategory(NamedTuple):
    key: str
    #: 属するグループの`key`。
    group: str


#: 道路のまとまり。
ROAD_OVERLAY_GROUP = OverlayGroup("road", "道路", initial_items=3)

#: 並びがそのまま「表示」の一覧の群の並び順になる。
MAP_OVERLAY_GROUPS: tuple[OverlayGroup, ...] = (
    ROAD_OVERLAY_GROUP,
    OverlayGroup("environment", "天気と地形", initial_items=2),
    OverlayGroup("spot", "スポット", initial_items=3),
)


class _LegendSharedRow(NamedTuple):
    label: str
    #: 凡例の行の（i）から開く説明。
    description: str


#: 行の宣言に当てはまらない道の受け皿の行。道の属性・レンズ・ルートのどの凡例でも同じ意味なので、名前と説明を
#: ここだけが持つ（鍵は画面が引く名前）。
LEGEND_SHARED_ROWS: dict[str, _LegendSharedRow] = {
    "other": _LegendSharedRow(
        "その他",
        "値は書かれているが、上のどの行にも当てはまらない道[まれな種類など]。",
    ),
    "notApplicable": _LegendSharedRow(
        "該当なし",
        "この種類に当たらない道[例: トンネルの凡例では、トンネルでない道]。",
    ),
    "noData": _LegendSharedRow(
        "データなし",
        "元にする地図のデータに値が無く、どの行にも分けられない道。道が無いのではなく、値が分からない。",
    ),
    "undetermined": _LegendSharedRow(
        "向きで決まらない",
        "地図の上の向き[走行中は進む向き]とほぼ直角に交わるため、値を決められない道[勾配なら登りか下りか]。\n"
        "・地図を回して向きが変わると色が付く。",
    ),
}

class MapLayerDataSource(NamedTuple):
    key: str
    #: このズーム未満では配信されない（ONにしても地図には何も出ない）。無いものはNone。
    min_zoom: int | None = None


#: タイルで配る一次属性の系統（`domain/registry.py: TileKind`の名前）。道の線の層の情報源は`_ROAD_LAYER_DATA_SOURCE`。
#: 情報源の名前にそのまま使う。
_TILE_KINDS: tuple[str, ...] = tuple(
    dict.fromkeys(attr.tile_kind for attr in PRIMARY_ATTRIBUTES if attr.tile_kind is not None)
)

#: 道の線の層（管理DBの区分を描く）の絵の出所。
_ROAD_LAYER_DATA_SOURCE = "road_surface"

#: レイヤーの絵がどこから来るか。取得状態（読み込み中・空・失敗）の判定はここから導く。
#: 最小ズームは配信の性質なので情報源の側で持つ——レイヤーごとに書くと、同じタイルを
#: 読むレイヤーの1つだけ書き忘れても型が通り、その行だけ案内が出ない。
MAP_LAYER_DATA_SOURCES: tuple[MapLayerDataSource, ...] = (
    MapLayerDataSource(_ROAD_LAYER_DATA_SOURCE, ROAD_SURFACE_TILE_MIN_ZOOM),
    *(MapLayerDataSource(kind, ROAD_TILE_MIN_ZOOM) for kind in _TILE_KINDS),
    MapLayerDataSource("gsiRelief"),
    MapLayerDataSource("landcoverRaster", LANDCOVER_TILE_MIN_ZOOM),
    MapLayerDataSource("ownFetch"),
    # MSMの格子点（`GET /api/weather/msm-grid`）。自前で取り、取得状態は取った側が出す。
    MapLayerDataSource("msmGrid", MSM_GRID_MIN_ZOOM),
)

#: 数値予報モデルの値を画面に出すときに、同じ文として添える断り。大きな誤差を含む可能性と、予報ではないことの両方を言う
#: （docs/architecture/data-sources.md「気象業務法の予報業務許可」節）。生成物（`mapDisplay.modelValueDisclaimer`）が画面へ届ける。
MODEL_VALUE_DISCLAIMER = "数値予報モデルの計算結果で、大きな誤差を含む可能性があります。予報ではありません。"

#: 値の性質。生データか、時刻で中身が変わるか。
MapLayerDataNature = Literal["raw", "dynamic"]
MAP_LAYER_DATA_NATURES: tuple[str, ...] = get_args(MapLayerDataNature)

#: レイヤーの種別と、属するグループ。**種別を1つ足すときは必ず所属も決まる**。並びが群の中の並びで、よく使う種別を先に
#: 置く（群の先頭から`OverlayGroup.initial_items`件が最初に一覧へ並ぶ）。
MAP_LAYER_CATEGORIES: tuple[LayerCategory, ...] = (
    LayerCategory("roadCondition", "road"),
    LayerCategory("weather", "environment"),
    LayerCategory("terrain", "environment"),
    LayerCategory("disaster", "environment"),
    LayerCategory("amenity", "spot"),
    LayerCategory("trafficSafety", "spot"),
)

#: 派生データベースの値を作った元の出典（HTML）。地図の出典表記と、書き出しの README の両方がここから組む。
ELEVATION_ATTRIBUTION = (
    '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">'
    "地理院タイル(標高タイル)</a>を加工して作成"
)
ACCIDENT_ATTRIBUTION = (
    '<a href="https://www.npa.go.jp/publications/statistics/koutsuu/opendata/index_opendata.html" target="_blank" '
    'rel="noreferrer">交通事故統計情報</a>[警察庁]を加工して作成'
)
#: CC BY 4.0 はライセンスへのリンクと、変えた旨を求める（3(a)(1)(B)(C)）。
LANDCOVER_ATTRIBUTION = (
    '土地被覆: <a href="https://livingatlas.arcgis.com/landcover/" target="_blank" rel="noreferrer">'
    "Esri, Impact Observatory, Microsoft</a>"
    ' (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>)を加工して作成'
)
#: JARTIC のオープンデータの利用規約の、加工した旨の記載例の形。
TRAFFIC_REGULATION_ATTRIBUTION = (
    '交通規制: 公益財団法人日本道路交通情報センター「<a href="https://www.jartic.or.jp/service/opendata/" '
    'target="_blank" rel="noreferrer">交通規制情報</a>」を加工して作成'
)
#: 派生データベース（道ごとの値の書き出し）の値を作った元のうち、OSM 以外のもの。OSM の表示は ODbL の文と一緒に README が持つ。
#: 材料の元を足したら、ここにも足す。
DERIVED_DATABASE_ATTRIBUTIONS: tuple[str, ...] = (
    ELEVATION_ATTRIBUTION,
    ACCIDENT_ATTRIBUTION,
    LANDCOVER_ATTRIBUTION,
    TRAFFIC_REGULATION_ATTRIBUTION,
)

#: 地図へ常に出す出典（HTML）。路面の色・評価・ルートの計算・常設の表示（ヘッダーの天気・警戒度バッジ）へ常に使う
#: データで、どのレイヤーを表示しているかと関係なく出典が要る（レイヤーのソースに付けると、そのレイヤーを消したとき
#: 出典も消える）。公共データ利用規約（PDL1.0）とCC BY 4.0は出典とは別に加工した旨を求め、標高からは勾配を、事故の点から
#: は区間ごとの件数を、アメダスと推計気象分布からは天気を、区域の境界は簡略化して、配信タイルは欠けたズームを隣の
#: ズームから補い降水の色を塗り替え災害の注意の段を薄くして、MSMの格子は地点・時刻へ補間して使っている。気象レイヤーの出典もここが持つ（気象庁のデータは常設の表示
#: で常に使うため）。住所の区画は地点の検索で常に使う。地点（立ち寄り先と地点の検索の施設）は出典を1か所にまとめるためここに置く。基礎地図は配信元のTileJSONが出典を持つので
#: 入れない（入れると2回並ぶ）。データ源を足したら、利用条件（docs/architecture/data-sources.md）と合わせてここも見る。
#: 自分の口・静的ファイルへのリンクは`{名前}`の差し込み口で書く。パスはそれを配る口・ファイルが持ち、生成物を組むときに埋める。
ALWAYS_SHOWN_ATTRIBUTIONS: tuple[str, ...] = (
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">'
    "OpenStreetMap contributors</a>",
    # OSM の派生データベースは公に使う間、受け取った人へ渡せるようにする（ODbL 4.6）。
    '道ごとの値の<a href="{derived_database}" target="_blank" rel="noreferrer">派生データベース(ZIP)</a>'
    '(<a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer">ODbL 1.0</a>)',
    ELEVATION_ATTRIBUTION,
    ACCIDENT_ATTRIBUTION,
    '<a href="https://www.jma.go.jp/" target="_blank" rel="noreferrer">気象庁ホームページ</a>'
    "(アメダス・警報・キキクル・ナウキャスト等)と気象庁"
    '「<a href="https://www.data.jma.go.jp/developer/gis.html" target="_blank" rel="noreferrer">'
    "予報区等GISデータ</a>」を加工して作成",
    "気象庁メソ数値予報モデル(MSM)を加工して作成。"
    '配布: <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Weather data by Open-Meteo.com</a>'
    ' (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>)',
    '暑さ指数: 出典 <a href="https://www.wbgt.env.go.jp/" target="_blank" rel="noreferrer">環境省熱中症予防情報サイト</a>',
    LANDCOVER_ATTRIBUTION,
    *ADDRESS_AREA_ATTRIBUTIONS,
    # Overture の地点は出どころごとに表示が要る（公式の文書 https://docs.overturemaps.org/attribution/ ）。
    # Foursquare の行は Apache 2.0 で、ライセンスの写し・変えた旨・NOTICE の全文を渡す。
    '地点: <a href="https://overturemaps.org/" target="_blank" rel="noreferrer">Overture Maps Foundation</a>'
    "の名前のある地点を、種類で分け近くの同じ店をまとめて加工。"
    "Data from Meta, Microsoft, PinMeTo, DAC, Uberall, OpenTravel "
    '(<a href="https://cdla.dev/permissive-2-0/" target="_blank" rel="noreferrer">CDLA Permissive 2.0</a>), '
    "AllThePlaces "
    '(<a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noreferrer">CC0 1.0</a>), '
    "Foursquare (Copyright 2024 Foursquare Labs, Inc. All rights reserved. Available under "
    '<a href="{apache_license}" target="_blank" rel="noreferrer">Apache 2.0</a>. '
    "Foursquare data was transformed to the Overture schema. "
    '<a href="{foursquare_notice}" target="_blank" rel="noreferrer">NOTICE</a>)',
    # ジャパンサーチのサイトポリシーの出典の記載例（編集・加工して使う場合）の形。
    '寺社: ジャパンサーチ「<a href="https://jpsearch.go.jp/database/bunka" target="_blank" rel="noreferrer">'
    "文化遺産オンライン[文化庁・国立情報学研究所]</a>」のメタデータを改変して利用[所有者で寺社ごとにまとめた]",
    TRAFFIC_REGULATION_ATTRIBUTION,
)


def _static_layer_ids() -> tuple[str, ...]:
    """地図へ出す一次属性（線・点は行の定義を持つもの、面は幾何が面のもの）。"""
    return tuple(attr.attr_id for attr in PRIMARY_ATTRIBUTES if attr.display_axes or attr.geometry == "area")


#: 地図に載るものの名前。費用の軸のレンズは実行時に決まるためここには現れない。
_MAP_LAYER_IDS: tuple[str, ...] = (*_static_layer_ids(), *WEATHER_LAYER_GROUPS)


#: 説明の文の差し込み口の名前。どれも実行時の応答（画面の設定・費用の軸の一覧）から来る値で、画面が埋める。
#: `accidentYears`は事故の収録年、`landcoverRingOuterM`は土地被覆の割合を数えた帯の外の幅（m。作り直しに使った値）。
LayerTextSlotName = Literal["accidentYears", "landcoverRingOuterM"]


class LayerTextSlot(NamedTuple):
    """説明の文の差し込み口。値が空なら、前後の文（`before`・`after`）ごと出さない——収録年が届く前に空の[]を出さない。"""

    name: LayerTextSlotName
    before: str = ""
    after: str = ""


#: 説明の文。地図で何が見えるかの文と、画面の設定・費用の軸の一覧から差し込む部分を並べる（設計原則「1つの値の中で混ざるときは、
#: 部分ごとに問う」）。
LayerText = tuple[str | LayerTextSlot, ...]


#: ルートの区間が層のidを鍵に持つ区分の並び（応答の`road_classes`）の、値の語彙。`landcoverClass`は土地被覆のクラスの割合の
#: 材料のid（`domain/landcover.py: LandcoverClass.percent_field`）。
SegmentSeries = Literal["landcoverClass"]


class MapLayerSpec(NamedTuple):
    #: 絵の出所（`MAP_LAYER_DATA_SOURCES`の`key`）。
    data_source: str
    #: 種別（`MAP_LAYER_CATEGORIES`の`key`）。どのグループにも属さないものはNone。
    category: str | None
    data_nature: MapLayerDataNature = "raw"
    #: 名前。一次属性を描くレイヤーは書かない——属性の名前をそのまま使う（`map_layer_label`）。
    label: str | None = None
    #: 何が分かるかの短い説明（1文。句点は付けない）。一覧の行のtitleと、ⓘの文の頭になる。地図に載るものは必ず持つ（`MAP_LAYERS`）。
    #: 費用の軸のレンズの説明は費用の軸の定義から作る。
    description: LayerText = ()
    #: ⓘで短い説明に続ける補足。1文ずつ「・」で始まる行にし（画面が箇条書きにする）、短い説明を繰り返さない。
    panel_hint: LayerText = ()
    #: 値の無い道の行（データなし・該当なし）を、最初は凡例で隠しておくか。値のある道が少なく、無い道の線が
    #: 地図を覆う道の線の層だけが持つ（利用者は凡例のチェックで出せる）。
    hide_missing_rows: bool = False
    #: 描き始める縮尺。情報源がタイルを配る縮尺より寄ってから描く層だけが持つ。
    draw_min_zoom: int | None = None
    #: ルートの区間がこの層のidを鍵に区分の並びを持つなら、その値の語彙。道の線の層の並びは区分の配りが持つので、ここには書かない。
    segment_series: SegmentSeries | None = None


def _tile_layer(
    attr_id: str,
    category: str,
    *,
    description: LayerText,
    panel_hint: LayerText = (),
    label: str | None = None,
    hide_missing_rows: bool = False,
) -> MapLayerSpec:
    """タイルで配る一次属性のレイヤー。情報源と描き始める縮尺は属性自身の宣言から決める。"""
    attr = PRIMARY_ATTRIBUTES_BY_ID[attr_id]
    tile_kind = attr.tile_kind
    assert tile_kind is not None, attr_id
    return MapLayerSpec(
        tile_kind,
        category,
        label=label,
        description=description,
        panel_hint=panel_hint,
        hide_missing_rows=hide_missing_rows,
        draw_min_zoom=attr.point_min_zoom,
    )


def _first_axis(attr_id: str) -> DisplayAxisSpec:
    """一次属性の先頭の見方（色を決める軸）。"""
    return PRIMARY_ATTRIBUTES_BY_ID[attr_id].display_axes[0]


def _point_kind_list(attr_id: str) -> str:
    """説明へ差し込む点の種別名の並び（凡例と同じ、先頭の軸の行）。区切りが読点なのは、名前が中黒を含むため。"""
    return "、".join(category.label for category in _first_axis(attr_id).categories)


def _row_label(attr_id: str, key: str) -> str:
    """説明へ差し込む凡例の行の名前（先頭の軸の行）。"""
    return next(category.label for category in _first_axis(attr_id).categories if category.key == key)


def _size_text(attr_id: str) -> str:
    """大きさで示す見方の文。半径を宣言した軸の、半径の最も大きい行の名前から組む。"""
    attribute = PRIMARY_ATTRIBUTES_BY_ID[attr_id]
    axis = next(
        axis for axis in attribute.display_axes if all(category.radius_px is not None for category in axis.categories)
    )
    return size_sentence(axis)


def size_sentence(axis: DisplayAxisSpec) -> str:
    """半径を宣言した軸の、半径の最も大きい行を名指す文。どの行も同じ半径なら、大きさで示していないので落とす。"""
    radii = {category.radius_px for category in axis.categories}
    if None in radii or len(radii) < 2:
        raise ValueError(f"{axis.key}は行ごとに違う半径を宣言していない")
    largest = max(axis.categories, key=lambda category: category.radius_px or 0)
    return f"{largest.label}は円を大きく表示します。"



def _source_jma_elements(source: str) -> tuple[str, ...]:
    """名前付きソースが段に並べる配信要素（同じソースを名乗る要素をすべて合わせる）。"""
    return tuple(e for element in WEATHER_ELEMENTS if element.source == source for e in element.jma_elements)


#: 降水の段の境目（配信の宣言の、予測が届く先）。降水は近い段から高解像度降水ナウキャスト・降水短時間予報と継ぐ。
_NOWCAST_REACH, _SHORT_RANGE_REACH = (forecast_reach(e) for e in _source_jma_elements("main"))
#: MSMの格子点の値を描く先（読み出しが予報を切る長さ）。
_MSM_REACH = reach_text(MSM_FORECAST_HOURS * 60)


def _label_list(labels: list[str]) -> str:
    """名前の並び。同じ名前を名乗る要素（描き方違いの同じ名前付きソース）は1つにする。"""
    return "・".join(dict.fromkeys(labels))


#: 災害の要素を、描くコマの規則ごとに言う語。並びが説明の並びになる。
_DISASTER_FRAME_RULE_WORDING: dict[FrameRuleKind, str] = {
    "nearest": "は{reach}先まで時刻スライダーで切り替えられます。",
    "latestObservation": "は最新の観測だけを出します。",
    "current": "は現在の危険度で、時刻に連動しません。",
}

def _disaster_by_frame_rule() -> list[tuple[str, str]]:
    """災害の要素の名前を、描くコマの規則ごとにまとめた並び（要素の無い規則は出さない）。説明の`{reach}`には、
    その規則の要素の予測が届く先を入れる。"""
    disaster = [element for element in WEATHER_ELEMENTS if element.group == "disaster"]
    if unworded := sorted({element.frame_rule.kind for element in disaster} - set(_DISASTER_FRAME_RULE_WORDING)):
        raise ValueError(f"災害の要素のコマの規則に、説明の語が無い: {unworded}")
    # 災害の凡例は名前付きソースごとの行が（i）から説明を開く。要素の説明は省ける欄なので、ここで断る。
    if undescribed := sorted(element.label for element in disaster if not (element.description or "").strip()):
        raise ValueError(f"災害の要素に、凡例の行が開く説明が無い: {undescribed}")
    rows = []
    for kind, detail in _DISASTER_FRAME_RULE_WORDING.items():
        elements = [element for element in disaster if element.frame_rule.kind == kind]
        if not elements:
            continue
        if "{reach}" in detail:
            detail = detail.format(reach=forecast_reach(*(e for element in elements for e in element.jma_elements)))
        rows.append((_label_list([element.label for element in elements]), detail))
    return rows


_DISASTER_BY_FRAME_RULE = _disaster_by_frame_rule()


#: `_MAP_LAYER_IDS`の1つずつの宣言。並びが一覧の行の並び（種別の中の順）になる。**過不足は生成の時点で落ちる**（`MAP_LAYERS`）。
_LAYER_SPECS: dict[str, MapLayerSpec] = {
    "elevation": MapLayerSpec(
        "gsiRelief",
        "terrain",
        description=("土地の高さを色で見られます",),
    ),
    # 塗らないのは、広い範囲を単色で覆って基礎地図を隠すわりに何も足さない分類だけ（`LandcoverClass.painted`）。
    "landcover": MapLayerSpec(
        "landcoverRaster",
        "terrain",
        segment_series="landcoverClass",
        description=("畑・草地・林・水辺など、土地の使われ方を色で見られます",),
        panel_hint=(
            f"・ルートの結果の「{PRIMARY_ATTRIBUTES_BY_ID['landcover'].label}」は道の周り",
            LayerTextSlot("landcoverRingOuterM", after="m"),
            "の割合で、この塗りとは別です。",
        ),
    ),
    "stop_poi": _tile_layer(
        "stop_poi",
        "trafficSafety",
        description=(f"止まったり減速したりする所[{_point_kind_list('stop_poi')}]です",),
    ),
    "supply_poi": _tile_layer(
        "supply_poi",
        "amenity",
        description=(f"{_point_kind_list('supply_poi')}の場所です",),
        panel_hint=(
            f"・「{_row_label('supply_poi', 'vending_drinks')}」は飲み物を売るもの、"
            f"「{_row_label('supply_poi', 'vending_unknown')}」は売るものが分からないものです。\n"
            f"・{_row_label('supply_poi', 'convenience')}はチェーンの店だけです。\n・閉店・撤去が反映されていないことがあります。",
        ),
    ),
    "stop_place": _tile_layer(
        "stop_place",
        "amenity",
        description=(f"{_point_kind_list('stop_place')}の場所です",),
        panel_hint=(
            "・寺社は国の文化財の建物を持つものです。\n"
            "・閉店にデータが追いついていないことがあり、現地と違う場合があります。",
        ),
    ),
    "accident_point": _tile_layer(
        "accident_point",
        "trafficSafety",
        description=("交通事故の起きた場所です", LayerTextSlot("accidentYears", "[", "]")),
        panel_hint=(f"・{_size_text('accident_point')}",),
    ),
    "precipitationNowcast": MapLayerSpec(
        "ownFetch",
        "weather",
        data_nature="dynamic",
        label="雨雲",
        description=("雨の降っている所と、この先の雨雲を、時刻を動かして見られます",),
        panel_hint=(
            f"・{_NOWCAST_REACH}先までは実況に近い予測、{_SHORT_RANGE_REACH}先までは短時間予報、"
            f"{_MSM_REACH}先までは数値予報モデルの値で、赤は線状降水帯です。\n・{MODEL_VALUE_DISCLAIMER}\n"
            "・取得に失敗することがあります。",
        ),
    ),
    # 「負担で塗る」の道路の塗り（向かい風・追い風）と見分けられる名前にする。
    "windVector": MapLayerSpec(
        "msmGrid",
        "weather",
        data_nature="dynamic",
        label="風",
        description=("風の向きと強さを、約5kmごとの矢印で見られます",),
        panel_hint=(
            "・矢印は風の吹いていく向きで、長く太いほど強い風です。\n"
            f"・{_MSM_REACH}先まで時刻で切り替えられます。\n・{MODEL_VALUE_DISCLAIMER}",
        ),
    ),
    # 回避するしかない危険なので、費用には入れず表示だけにする。
    # 要素の名前と、時刻に対する振る舞いは要素の宣言から組み立てる。段の数と名前は凡例に並ぶので文に書かない。
    "disaster": MapLayerSpec(
        "ownFetch",
        "disaster",
        data_nature="dynamic",
        label="災害の危険度",
        description=("気象庁の防災情報の危険度を地図に出します",),
        panel_hint=(
            "・危険の無いときは何も出ません。\n"
            + "".join(f"・{labels}{detail}\n" for labels, detail in _DISASTER_BY_FRAME_RULE)
            + "・取得に失敗することがあります。",
        ),
    ),
}


def map_layer_label(layer_id: str, spec: MapLayerSpec) -> str:
    """レイヤーの名前。一次属性を描くレイヤーは属性の名前で、どちらも無ければ生成の時点で落とす。"""
    if spec.label is not None:
        return spec.label
    attribute = PRIMARY_ATTRIBUTES_BY_ID.get(layer_id)
    if attribute is None:
        raise ValueError(f"地図レイヤー'{layer_id}'に名前が無い（一次属性でもない）")
    return attribute.label


def _map_layers() -> tuple[tuple[str, MapLayerSpec], ...]:
    """宣言を`_MAP_LAYER_IDS`と突き合わせる。名前の重なり（一次属性・気象のグループ・ルートが同じ名前）・
    宣言の過不足・説明の書き忘れは、どれも生成の時点で落とす。"""
    if sorted(_MAP_LAYER_IDS) != sorted(_LAYER_SPECS):
        raise ValueError(f"地図レイヤーの宣言が名前と合わない: {sorted(_MAP_LAYER_IDS)} / {sorted(_LAYER_SPECS)}")
    undescribed = [layer_id for layer_id, spec in _LAYER_SPECS.items() if not spec.description]
    if undescribed:
        raise ValueError(f"地図レイヤーに説明が無い: {undescribed}")
    return tuple(_LAYER_SPECS.items())


#: 地図に載るものの宣言（`_LAYER_SPECS`の順）。
MAP_LAYERS: tuple[tuple[str, MapLayerSpec], ...] = _map_layers()


def segment_series_layer(series: SegmentSeries) -> str:
    """区間に`series`の並びを載せる層のid。ちょうど1つの層が宣言していなければ`ValueError`。"""
    layer_ids = [layer_id for layer_id, spec in MAP_LAYERS if spec.segment_series == series]
    if len(layer_ids) != 1:
        raise ValueError(f"区間の区分の並び'{series}'を載せる層が1つに決まらない: {layer_ids}")
    return layer_ids[0]


#: 実行時に決まるレイヤーに共通の宣言。`dedicated`は費用の軸のレンズのレイヤーで、路面タイルの道へ道ごとに配る
#: 1kmあたりの代償の秒の色を塗る（値は時刻の風で変わりうる）。`road`は道の線の層で、種別は層ごとに画面の設定の`road_classes`が配る。
AXIS_LAYER_SPECS: dict[str, MapLayerSpec] = {
    # レンズは道ごとの値を路面タイルの道ごとの鍵で置くので、鍵を持つ縮尺から描く。
    "dedicated": MapLayerSpec(_ROAD_LAYER_DATA_SOURCE, None, data_nature="dynamic", draw_min_zoom=ROAD_TILE_MIN_ZOOM),
    "road": MapLayerSpec(_ROAD_LAYER_DATA_SOURCE, None),
}


def check_map_layer_declarations(
    groups: Iterable[OverlayGroup],
    categories: Iterable[LayerCategory],
    sources: Iterable[MapLayerDataSource],
    specs: Iterable[MapLayerSpec],
) -> None:
    """宣言どうしが名前（`key`）で指し合う先が1つに決まることを確かめ、外れれば`ValueError`。

    指した先が無いレイヤーは取得状態（読み込み中・空・失敗）を判定できず、一覧のどの群にも出ない。同じ名前が2つあると、
    指した側はどちらか一方だけを読む。種別の無いグループのチップは押しても何も出ない。"""
    groups, categories, sources, specs = tuple(groups), tuple(categories), tuple(sources), tuple(specs)
    for name, declarations in (("グループ", groups), ("種別", categories), ("情報源", sources)):
        repeated = sorted(key for key, n in Counter(d.key for d in declarations).items() if n > 1)
        if repeated:
            raise ValueError(f"{name}の名前が重なる: {repeated}")
    group_keys = {group.key for group in groups}
    category_keys = {category.key for category in categories}
    source_keys = {source.key for source in sources}
    if stray := sorted({category.group for category in categories} - group_keys):
        raise ValueError(f"種別が宣言に無いグループを指す: {stray}")
    if empty := sorted(group_keys - {category.group for category in categories}):
        raise ValueError(f"種別の無いグループがある: {empty}")
    if stray := sorted({spec.category for spec in specs if spec.category is not None} - category_keys):
        raise ValueError(f"レイヤーが宣言に無い種別を指す: {stray}")
    if stray := sorted({spec.data_source for spec in specs} - source_keys):
        raise ValueError(f"レイヤーが宣言に無い情報源を指す: {stray}")


check_map_layer_declarations(
    MAP_OVERLAY_GROUPS,
    MAP_LAYER_CATEGORIES,
    MAP_LAYER_DATA_SOURCES,
    (*_LAYER_SPECS.values(), *AXIS_LAYER_SPECS.values()),
)


def zoom_curve(*stops: tuple[float, float]) -> tuple[tuple[float, float], ...]:
    """ズームから値への曲線（ズーム, 値）の並びを、そのまま返す。ズームが厳密に昇順でなければ`ValueError`。

    地図の式（MapLibreの`interpolate`・`step`）は入力の段が厳密に昇順でないと式ごと失敗し、レイヤーが黙って消える。"""
    zooms = [zoom for zoom, _ in stops]
    if not zooms or zooms != sorted(set(zooms)):
        raise ValueError(f"ズームが厳密に昇順でない: {zooms}")
    return stops


#: 利用者が作った線の太さ（px）。役割ごとに違うのは、同じ道の上へ重ねたときに
#: どれが手前かを太さで読ませるため。
ROUTE_LINE_WIDTHS_PX: dict[str, float] = {
    "candidate": 2.5,
    "selectedHalo": 10,
    "splice": 3,
    "composite": 7,
    "detail": 6,
    # 選んだ区間の範囲の縁取り。選んだ候補の縁取り（`selectedHalo`）の外へはみ出す太さにする。
    "selectedSection": 18,
}

#: 縁取りは線の両側へ一定を足す。**個別に書かない**——線の太さを変えたときに縁取りだけ
#: 古い値で残ると、線が縁からはみ出す。
_CASING_MARGIN_PX = 4
ROUTE_CASING_WIDTHS_PX: dict[str, float] = {
    role: ROUTE_LINE_WIDTHS_PX[role] + _CASING_MARGIN_PX for role in ("composite", "detail")
}

#: 線の濃さ（役割ごと）。候補の参考線は選んだ候補より薄くする。`travelled`は走行中に走り終えた区間で、
#: 残りの道と見分けられるだけ薄くし、ルートの線と道のりの負担のグラフの両方に当てる。
ROUTE_LINE_OPACITIES: dict[str, float] = {
    "selectedHalo": 0.25,
    "splice": 0.75,
    "candidate": 0.65,
    "arrowHalo": 0.95,
    "travelled": 0.35,
    "selectedSection": 0.45,
}

#: 破線の刻み。実線との違いが読める最小の組み合わせ。
ROUTE_SPLICE_DASH: tuple[float, ...] = (2, 1.5)

#: 進行方向の矢印。大きさはズームに追従させる——固定ピクセルだと、拡大するほど
#: 周囲の道路だけが太くなり矢印が相対的に小さく見える。
ROUTE_ARROW_SPACING_PX = 80
ROUTE_ARROW_HALO_SCALE = 1.5
ROUTE_ARROW_SIZE_BY_ZOOM = zoom_curve((10, 0.6), (13, 0.8), (16, 1.2), (19, 1.6))


#: 面の濃さ。下限は「最も薄い階級が背景に対してΔE（CIE76）15以上」、上限は面の下にある
#: 土地の塗りが潰れない範囲。**上下から挟まれている**ので片側だけを見て動かさない。
AREA_OPACITY = 0.55

#: 陰影。北西からの斜め光（真上からだと起伏が出ない）。`igor`は傾きのarctanに比例する
#: ——既定の`standard`はsinに比例し、平野部の数度では実効の濃さが0.03を下回って見えない。
HILLSHADE_ILLUMINATION_DEG = 315
HILLSHADE_METHOD = "igor"
#: `igor`は傾きの大きさを`exaggeration * 2`倍してから角度へ直す。上限の1にする。
HILLSHADE_EXAGGERATION = 1
#: 陰影の濃さは影・光の色のalphaで渡す（hillshadeは不透明度のプロパティを持たない）。傾きが0の画素は
#: 影も光も出ないため、上げても平地は濁らない。
HILLSHADE_SHADOW_COLOR = f"rgba(60, 50, 40, {AREA_OPACITY})"
HILLSHADE_HIGHLIGHT_COLOR = f"rgba(255, 252, 245, {AREA_OPACITY})"
#: 標高の強調。**タイルの値は実際の標高のままで、読み方（復元式の係数）へ掛ける**
#: ——タイル側を書き換えると、同じタイルを別の倍率で読み直せなくなる。
#: 上げるほど緩い斜面が読めるが、上げすぎると急斜面との差が潰れる。
TERRAIN_EXAGGERATION = 5

#: 気象の記号。風は速さで大きさを変え、`WIND_FULL_SCALE_MS`で上限に達する。
WIND_ICON_SCALE_RANGE: tuple[float, float] = (0.8, 1.4)
WIND_FULL_SCALE_MS = 15
LIGHTNING_ICON_SCALE = 0.8
#: 記号を拡大する曲線（ズーム→倍率）。**気象の記号はどれも同じ曲線で拡大する**——家族ごとに別の曲線を使うと、
#: 同じ地図の中で拡大の速さが食い違う。`icon-size`は既定で画面上の固定ピクセルなので、曲線が無いと拡大するほど
#: 周囲の道路・建物だけが大きく描かれ、記号が相対的に小さくなる。初期表示のズーム（13）を倍率1に置く。
MARK_SIZE_BY_ZOOM = zoom_curve((10, 0.75), (13, 1), (16, 1.5), (19, 2))
#: 洪水の川筋の太さ（ズーム→px）。低いズームで目立たせすぎず、拡大するほど個々の川筋を追えるようにする。
FLOOD_LINE_WIDTH_BY_ZOOM = zoom_curve((6, 1.5), (10, 3), (14, 5))
#: 線状降水帯の雨域の輪郭線の太さ（px）と、下に敷く縁取りの太さ。配信元の公式の画面の描画定義の値
#: （`strokeWidth`と、縁取りはその+2）で、ズームによらない。
RAINBAND_OUTLINE_WIDTH_PX = 4
RAINBAND_OUTLINE_CASING_WIDTH_PX = RAINBAND_OUTLINE_WIDTH_PX + 2


#: 道の線。太さは意味を運ばない（意味は色だけ）ので、分類の線はすべて同じ太さ。
#: 横に分ける間隔は太さより狭くして隣どうしをわずかに重ねる——離すと1本の道が複数に見える。
ROAD_LINE_WIDTH_PX = 3
ROAD_TRACK_OFFSET_STEP_PX = 2
#: 分類がある道は濃く、値が無い・分類の外の道は薄く（消さずに薄くする）。薄い側も、基礎地図の地色に対して灰の線が
#: コントラスト比1.5を割らない濃さにする——割ると、道があるのに線が無いように見える。
ROAD_KNOWN_OPACITY = 0.8
ROAD_UNKNOWN_OPACITY = 0.6
#: 詳細を見ている1本の強調。元の線が上に乗ったままになる太さにする。
ROAD_INSPECTED_WIDTH_PX = 8

#: 道路タブで好む・避けるにした道を通ったルートの区間の強調。ルートの線の両脇に細い線を添え、ルートの線の後ろに太く敷く
#: 選んだ区間の帯（`ROUTE_LINE_WIDTHS_PX["selectedSection"]`）と形で見分ける。好むは実線、避けるは破線で、破線の刻みは値の無い線
#: （`NO_DATA_DASH`）・乗り換え帯（`ROUTE_SPLICE_DASH`）と別にする。添える線の中心は、ルートの線の縁取りから間隔だけ外に置く。
AVOIDANCE_RAIL_WIDTH_PX = 2
AVOIDANCE_RAIL_GAP_PX = 2
AVOIDANCE_AVOIDED_DASH: tuple[float, ...] = (3, 2)
#: 道路タブを地図で見ている間に、好む・避ける・通らないの道を塗る線の太さ（縮尺→px）。横に分けて並べた道の線の層を覆い、
#: 寄るほど基礎地図の道そのものの太さに近づける。
ROAD_AVOIDANCE_WIDTH_BY_ZOOM = zoom_curve((12, 3), (14, 5), (16, 9), (18, 18))

#: 値が無い（不明・データなし）線の破線の刻み（線の太さを1とする長さ）。道の線・レンズの線・ルートの線で共有する。
#: 乗り換え帯の破線（`ROUTE_SPLICE_DASH`）より細かく刻み、操作の状態と見分けられるようにする。
NO_DATA_DASH: tuple[float, ...] = (1, 2)

#: 点の大きさを決める軸で、半径（`DisplayCategorySpec.radius_px`）を宣言しない行の半径。点の絵の大きさは行の半径の比で決まる。
POINT_RADIUS_PX = 4
POINT_STROKE_WIDTH_PX = 1
#: 点の絵の一辺。中の絵を読める大きさにする。
POINT_ICON_SIZE_PX = 20
POINT_OPACITY = 0.9
#: 点のタイルが近い点を1つの代表点に束ねる升目の数（タイルの一辺を等分する数）。升目はタイルの端に揃うので、隣り合うタイルで
#: 同じ点が別々の代表点にならない。地図は1つのタイルを一辺512画素から描くので、一辺の升目は32画素から（点の絵が重なり合わない幅）。
#: 一番寄った縮尺のタイル（`domain/region.py: ROAD_TILE_MAX_ZOOM`）も同じ数で切る——それより寄った地図はこのタイルを引き伸ばして
#: 描くので、升目を細かくすると、引き伸ばす前の升目が点の絵より小さくなり、隣り合う升目の代表点の絵が重なる。
POINT_CLUSTER_CELLS_PER_TILE = 16
#: 代表点が束ねた点の数を持つタイルのプロパティ。
POINT_COUNT_PROPERTY = "count"
#: 代表点が束ねた名前のある点（代表点そのものも入る）を持つタイルのプロパティ。2点以上を束ねたときだけ持ち、
#: 値は`[名前, 経度, 緯度]`の並びのJSONの文字列（MVTの属性は配列を持てない）。
POINT_MEMBERS_PROPERTY = "members"
#: 区間を選んでいる間、地図の点のうち区間の近くに数える、区間の線からの地上の距離（m）。
SEGMENT_NEARBY_POINT_MAX_DISTANCE_M = 100.0


def _point_opacities() -> dict[str, float]:
    """地図に点で出す一次属性（点の幾何・行の定義・タイルの系統を持つもの）ごとの不透明度。行が宣言しなければ既定。"""
    return {
        attr.attr_id: POINT_OPACITY if attr.point_opacity is None else attr.point_opacity
        for attr in PRIMARY_ATTRIBUTES
        if attr.geometry == "point" and attr.display_axes and attr.tile_kind is not None
    }


#: 一次属性 → 点の不透明度。画面は点のレイヤーごとに自分の名前で引く。
POINT_OPACITY_BY_ATTR: dict[str, float] = _point_opacities()
