"""評価軸が参照する材料（material）の正式カタログ。

`domain/axis_definitions.py: AXIS_DEFINITIONS`の各軸（`MaterialTerm.material`・
`CategoricalShape.material`）が参照する材料idの単一ソース（詳細は
docs/modules/backend/evaluation-scoring.md「材料カタログ」参照）。

**材料の「登録」と「評価軸での利用」は独立している**: 既存の軸が使わない生データ
（highway・surface・smoothness等）も、「評価や地図描画に使えそうな生データ」として本カタログへ
網羅的に登録する。登録済みでも対応する軸が無ければ評価には使われない（軸の定義ファイルから
使える）。

材料自体はGUIから追加・編集・削除できない（コード変更＋デプロイが前提）。frontendは本カタログを
ビルド時の生成物（`scripts/export_openapi.py`が書き出す`material-catalog.json`）だけから知る。

`tile_property`はMVTタイル（`road_tile_sql.py: ROAD_SURFACE_TILE_MVT_SQL`）へ焼き込む
プロパティ名（Noneなら材料がタイルに載らない）。
"""

from dataclasses import dataclass

from typing import Literal, NamedTuple

from pydantic import ConfigDict, Field, field_validator, model_validator

from app.domain.landcover import (
    LANDCOVER_CLASSES,
    LANDCOVER_RING_OUTER_M,
    LandcoverClass,
    landcover_key,
)
from app.domain.divided_carriageway import DIVIDED_ROAD_NOTE, oneway_material_sql
from app.domain.registry import PrimaryAttributeSpec
from app.domain.primary_attributes import (
    PRIMARY_ATTRIBUTES,
    ATTR_ACCIDENT_POINT,
    ATTR_CYCLEWAY,
    ATTR_ELEVATION,
    ATTR_HIGHWAY,
    ATTR_INTERSECTION,
    ATTR_LANDCOVER,
    ATTR_LANES,
    ATTR_LIT,
    ATTR_MAXSPEED,
    ATTR_MOTOR_VEHICLE_ACCESS,
    ATTR_ONEWAY,
    ATTR_STOP_POI,
    ATTR_SURFACE,
    ATTR_TRACKTYPE,
    ATTR_TUNNEL,
)

from app.domain.material_sql import (
    BICYCLE_NORMALIZED_SQL,
    BRIDGE_STRUCTURE_VALUES,
    CYCLEWAY_HIGHWAY,
    CYCLEWAY_LANE_VALUES,
    CYCLEWAY_SHARED_VALUES,
    CYCLEWAY_TRACK_VALUES,
    SHARED_PEDESTRIAN_PATH_NOTE,
    SHARED_PEDESTRIAN_PATH_SQL,
    TUNNEL_STRUCTURE_VALUES,
    LANES_COUNT_CASE_SQL,
    MAXSPEED_KMH_CASE_SQL,
    SMOOTHNESS_NORMALIZED_SQL,
    SURFACE_NORMALIZED_SQL,
    TRACKTYPE_NORMALIZED_SQL,
    cycleway_has_value_sql,
    landcover_value_sql,
    per_km_value_sql,
    poi_density_value_sql,
    reads_segment_values,
    BRIDGE_NORMALIZED_SQL,
    CYCLEWAY_TAG_NAMES,
    HIGHWAY_SQL,
    IS_BRIDGE_SQL,
    IS_TUNNEL_SQL,
    LIT_NORMALIZED_SQL,
    MOTOR_VEHICLE_NORMALIZED_SQL,
    TUNNEL_NORMALIZED_SQL,
    tag_is_value_sql,
    normalized_tag_sql,
    tag_absent_is_false_sql,
    tag_note,
)
from app.domain.traffic import (
    INTERSECTION_DEGREE_THRESHOLD,
    POI_COUNT_KINDS,
    poi_density_material_id,
)
from app.domain.rain import HOURS_SINCE_RAIN, RAIN_HISTORY_HOURS, RAIN_WINDOW_HOURS, rain_window_material_id
from app.domain.weather import PRECIPITATION_MIN_MM
from app.domain.wind import WIND_DRAG_REFERENCE_SPEED_KMH, WIND_DRAG_REFERENCE_SPEED_MS, wind_drag_ratio
from app.domain.strict_model import StrictModel

Population = Literal["way", "edge"]
# "unknown": 欠損は不明値（NaN/None）として扱われ、その材料を使う軸は評価対象外になる。
# "definite": 欠損は確定値（タグ不在=非該当等）として扱われ、軸は通常どおり評価される。
MissingSemantics = Literal["unknown", "definite"]

#: 母集団の表示名（管理画面の欠損率）。
POPULATION_LABELS: dict[Population, str] = {"way": "Way", "edge": "Edge"}

class MissingSemanticsDisplay(NamedTuple):
    title: str
    hint: str
    #: 欠損が評価に穴を開けるか。開けない扱いの欠損率は参考として、画面は薄く出す。
    affects_evaluation: bool


#: 欠損の扱いの見出しと説明（管理画面の欠損率）。意味が正反対のため、画面は同じ表へ並べず見出しで分ける。
#: 並びが画面の並び順。
MISSING_SEMANTICS_DISPLAY: dict[MissingSemantics, MissingSemanticsDisplay] = {
    "unknown": MissingSemanticsDisplay(
        "評価に影響する欠損", "元データが無い区間では、この材料を使う軸が評価対象外になる。", True
    ),
    "definite": MissingSemanticsDisplay(
        "タグ不在を確定値として評価する材料（参考）", "欠損は「該当なし」を意味し、評価に穴は開かない。", False
    ),
}


@dataclass(frozen=True)
class WayMaterialCoverageSpec:
    """道の生データ全行（別名`w`）を母集団とする材料。`missing_condition`はその列・
    JSONB参照のみで構成したSQL真偽式（trueなら欠損）で、外部入力を連結しない。

    欠損は生データの全行について数える。値を埋めるバッチが一部の行しか処理しない材料では、
    **対象外の行まで欠損に数えられ、欠損率が構造的に0へ到達しない**——運用者は「もう一度流せば
    0になるはず」と読むが決してならず、未実行なのか対象外なのかを画面から区別できない。"""

    missing_condition: str
    source: str
    missing_semantics: MissingSemantics
    population: Population = "way"


@dataclass(frozen=True)
class EdgeMaterialCoverageSpec:
    """`road_edges`全行を母集団とする材料。

    `present_condition`は区間の値（別名`em`）が「値を持つ」ときに真になるSQL条件式。
    区間の値は区間1本につき1行に結ばれるため、way母集団と同じく全材料を1回の走査で数えられる。"""

    present_condition: str
    source: str
    missing_semantics: MissingSemantics
    population: Population = "edge"


@dataclass(frozen=True)
class CoverageExcluded:
    """欠損率を測らない材料と、その理由。`MaterialSpec.coverage`が
    `WayMaterialCoverageSpec`/`EdgeMaterialCoverageSpec`とこの型のいずれかを必ず持つため、
    「どちらの一覧にも載っていない材料」は型として作れない。

    測らない材料も`missing_semantics`は持つ。**欠損率を測るかと、値が無いときにどう
    扱うかは別の問い**で、後者は地図の表示（`display_axis_missing_semantics`）が全材料について読む
    ——3つの型のうち1つだけがこの宣言を欠くと、そこだけ答えを作り出すことになる。"""

    reason: str
    missing_semantics: MissingSemantics


MaterialCoverage = WayMaterialCoverageSpec | EdgeMaterialCoverageSpec | CoverageExcluded


def _landcover_coverage(key: str) -> EdgeMaterialCoverageSpec:
    """土地被覆1クラスの欠損判定。クラスごとに書き写すと、増えたときここだけ取り残される。

    **値を読む列そのものを数える**（`landcover_value_sql`が読む`em.lc_*`）。
    別の表を数えると、値が空でも「揃っている」と報告しうる。列がNULLなら値が無い
    （NULLの意味は`docs/modules/backend/static-road-attributes.md`「値が無ければNULL」）。
    """
    return EdgeMaterialCoverageSpec(
        present_condition=f"{landcover_value_sql(key)} IS NOT NULL",
        source=f"edge_landcover.lc_{key}（derive_landcoverの計算済み値）の有無",
        missing_semantics="unknown",
    )

_CYCLEWAY_TAGS_COVERAGE = WayMaterialCoverageSpec(
    missing_condition=" AND ".join(f"tags->>'{tag}' IS NULL" for tag in CYCLEWAY_TAG_NAMES),
    source=f"OSM wayのタグ {' / '.join(CYCLEWAY_TAG_NAMES)}（いずれも無い場合に欠損）",
    missing_semantics="definite",
)
#: 生データの道は親の表のCHECK（`infrastructure/source_models.py: source_features_way_has_kind`）でhighwayを必ず持つ。
#: 街灯・自動車の通行止めを判定するタグと値。判定の式と説明の文が同じ組を引く。
_LIT_YES = ("lit", "yes")
_MOTOR_VEHICLE_NO = ("motor_vehicle", "no")
_HIGHWAY_ALWAYS_PRESENT = "生データの道はDBの制約でhighwayタグを必ず持ち、欠損が無い"
_EDGE_COUNTS_COVERAGE = EdgeMaterialCoverageSpec(
    present_condition="em.intersection_count IS NOT NULL",
    source="区間の数の表（edge_counts）に行があるか",
    missing_semantics="unknown",
)


MaterialDType = Literal["numeric", "boolean", "categorical"]

#: はい/いいえの材料の値の論理名（対応表のキーの綴り→論理名）。
_BOOLEAN_VALUE_LABELS = {"true": "はい", "false": "いいえ"}

#: 材料の値の出どころ。`db`はDBの値式（`MaterialSpec.value_sql`）で求める。`request`はリクエストの条件（風・
#: 想定速度）から都度求め、`domain/dynamic_materials.py: DYNAMIC_MATERIAL_EVALUATORS`が評価する。`observation`は
#: 観測から都度引き、静的スコア行列の組み立てへ観測の列として渡す（`evaluation.py: build_static_edge_score_matrix`）。`road_class`は
#: 道の区分から都度作る（`domain/road_classes.py: class_columns`）。
MaterialSource = Literal["db", "request", "observation", "road_class"]



class MaterialSpec(StrictModel):
    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    material_id: str
    label: str
    # 材料が何の値かの説明。軸の定義ファイルを書く人が材料を選ぶときに読む。
    description: str = Field(min_length=1)
    dtype: MaterialDType
    # 値の単位（凡例・数値表示用の表記、無次元・真偽値・カテゴリ値は空文字）。地図の凡例が
    # 材料の生値を表示するときの単位の唯一の正（frontendは単位を持たない）。
    unit: str = ""
    # 同じ単位の他の材料と**足し合わせて意味を持つ量**か（示量／示強の区別）。回・件・個の
    # ような個数と、それを同じ距離で割った密度（回/km等）は足せる。%・km/h・倍率のような
    # 割合・率は、母数の違うものを足しても何も表さないためFalseのまま。
    # domain/axis_raw_value.py: raw_value_unitは、2項以上の重み付き和の生値を利用者へ見せて
    # よいかの判定にこれを使う（単位が揃っているだけでは和の意味は保証されない）。
    additive: bool = False
    # 距離を掛けた総量（例: 「0.8回/km」→「約26回」）を出すときの単位。**総量が読み手の
    # 判断を変える量にだけ置く**——回・件のように数えられる出来事は「この経路で何回止まるか」
    # を答えるが、角度のような連続量は総量（「約3322度曲がる」）を出しても比べる尺度が無い。
    # `additive`（足し合わせて意味を持つか）とは別の問い: 事故密度は足せるが、総量は読めない。
    # 単位が「◯◯/km」であることだけを条件にすると、この区別が付かない。
    total_unit: str | None = None
    # MVTタイルへ既に焼き込み済みのプロパティ名。Noneは「タイル非依存」（GSI標高の都度取得、
    # 気象の動的取得、レシピ合成値等）。
    # タイルの列は、この名前と`value_sql`から組み立てる（`tile_column_sql`）。
    tile_property: str | None
    # この材料の由来となる一次属性。`domain/primary_attributes.py: PRIMARY_ATTRIBUTES`の要素そのものを、表の中で付けた名前で指す
    # （表の外の宣言は`_check_primary_attribute_is_declared`が断る）。
    # 材料id（例: highway_is_cycleway・maxspeed_kmh・intersection_count_per_km）と一次属性id
    # （例: cycleway・maxspeed・intersection）は名前が異なる別の名前空間のため、対応が
    # 自明でない材料には明示的にここへ書く。Noneは「対応する一次属性が無い」（動的データ
    # 由来のwind_drag_ratio、一次属性未登録のbridge/smoothness等）。GET /api/axis-catalogが
    # 軸ごとにこれを解決して返すことで、画面の軸と一次属性レイヤーの連動が、管理APIから入れた
    # 軸にも同じ仕組みで効く。
    primary_attribute: PrimaryAttributeSpec | None = None
    # 値の出どころ（`MaterialSource`）。リクエストごとに決まる材料の集合・観測の列として受ける材料の集合は
    # ここから導く（`materials_of_source`）。値式・欠損率の測り方との揃いは`_check_fields_match_the_source`が見る。
    source: MaterialSource = "db"
    # この材料の値をDBから求めるSQL式。読み出し側がFROM句で固定の別名（`material_sql.py`の
    # モジュールの説明の表）を用意し、この式をそのまま並べる。出どころが`db`の材料だけが持つ。
    # **材料の値の求め方をここ以外へ書かない**
    # （設計原則 構造仕様8。別の辞書へ分けると、材料を増やしたとき片方が取り残される）。
    value_sql: str | None = None
    # 欠損率の測り方（`/admin`の材料タブ）。`CoverageExcluded`を含む3択で、**どれかを必ず
    # 持つ**——「どちらの一覧にも載っていない材料」を型として作れなくする。中身は
    # `value_sql`から導けない（「値がいくつか」と「元データがあるか」は別の問い。
    # 例: `lit`の値は欠損をfalseへ畳むが、欠損率はタグの有無を数える）。
    coverage: MaterialCoverage
    # 材料の値（OSMタグ生値）ごとの日本語ラベル対訳表（タグ値→ラベル）。
    # highway/surface/smoothnessのようなオープンエンドな多値材料だけが持つ（他は空dict）。
    # 地図のポップアップと軸スタジオの値ごとの延長が表示するラベルの単一ソース。値の意味は材料そのものの
    # 定義に属するドメイン知識のため、他のフィールドと同じくここ（MaterialSpec自体）へ
    # 一元化する（material_id文字列をキーにした別の並列辞書にすると、材料の追加・削除の
    # たびに2箇所を同期する必要が生じるリスクを持ち込むため避ける）。
    value_labels: dict[str, str] = {}

    def value_label(self, value: str) -> str:
        """タグ生値から「論理名 - 物理名」形式の表示用ラベルを組み立てる
        （例: "自転車専用道 - cycleway"）。対訳表に無い値は物理名のみ返す
        （フォールバック、新しいOSMタグ値がDBに現れてもAPIが失敗しないようにするため。
        この場合論理名が無いため" - "を付けない）。はい/いいえの材料の値は対応表のキーの綴り（"true"/"false"）で受ける。"""
        labels = _BOOLEAN_VALUE_LABELS if self.dtype == "boolean" else self.value_labels
        label = labels.get(value)
        if label is None:
            return value
        return f"{label} - {value}"

    def full_label(self) -> str:
        """材料名を「論理名 - 物理名」形式の表示用ラベルにする（例: "道路種別 - highway"、
        value_labelと同じ理由で軸スタジオの一覧に物理名[material_id]を併記する）。"""
        return f"{self.label} - {self.material_id}"

    @field_validator("primary_attribute")
    @classmethod
    def _check_primary_attribute_is_declared(cls, attr: PrimaryAttributeSpec | None) -> PrimaryAttributeSpec | None:
        """表の要素そのものだけを受ける。地図の表示の軸は材料を宣言そのもので照らし（`display_axis_missing_semantics`）、
        軸カタログは`attr_id`で地図の層を引くので、表の外の宣言（同じ`attr_id`の写しも）を指す材料は、どちらかの連動を黙って外す。"""
        if attr is not None and not any(attr is declared for declared in PRIMARY_ATTRIBUTES):
            raise ValueError(f"{attr.attr_id}: 材料の一次属性は`primary_attributes.py: PRIMARY_ATTRIBUTES`の要素そのものを指す")
        return attr

    @model_validator(mode="after")
    def _check_fields_match_the_dtype(self) -> "MaterialSpec":
        """dtypeと噛み合わない宣言を登録時に落とす。通すと、その材料を選んだ画面だけが
        黙って何も出さない（対訳の効かない値）。"""
        if self.total_unit is not None and not self.unit:
            # 総量は生値へ距離を掛けた量で、単位の無い材料には掛ける相手が無い
            # （`axis_raw_value.py: raw_value_units`は`unit`が空の軸の総量を先に落とす）。
            raise ValueError(f"{self.material_id}: total_unitはunitを持つ材料にだけ置ける")
        if self.value_labels and self.dtype != "categorical":
            raise ValueError(f"{self.material_id}: value_labelsはcategorical材料の値にだけ付く")
        if self.tile_property is not None and self.value_sql is None:
            # タイルの列は値式から組む（`tile_column_sql`）。式を持たない材料の列は手で書くしかなく、
            # 地図と評価が別々の求め方になる。
            raise ValueError(f"{self.material_id}: タイルへ焼く材料は値式（value_sql）を持つ")
        return self

    @model_validator(mode="after")
    def _check_fields_match_the_source(self) -> "MaterialSpec":
        """出どころと噛み合わない宣言を登録時に落とす。値式を持つのにDB以外とした材料は値式が行列へ載って
        都度の値と二重になり、値式を持たないのにDBとした材料は行列に列が無く、どの軸でも黙って欠損になる。"""
        if (self.source == "db") != (self.value_sql is not None):
            raise ValueError(f"{self.material_id}: 値式（value_sql）は出どころがdbの材料だけが持つ")
        if self.source != "db" and not isinstance(self.coverage, CoverageExcluded):
            # 欠損率はDBの値を数えるので、DBに値を持たない材料には数える相手が無い。
            raise ValueError(f"{self.material_id}: 出どころがdbでない材料は欠損率を測らない（CoverageExcluded）")
        return self


_WIND_REFERENCE_SPEED_LABEL = f"時速{WIND_DRAG_REFERENCE_SPEED_KMH:g}km"


def _wind_drag_ratio_by_situation() -> dict[str, float]:
    """基準速度で走るときの代表的な風の状況ごとの`wind_drag_ratio`（走行方位0度を基準に、
    風向差0度=向かい風・180度=追い風・90度=真横）。材料の目安の一覧と説明文の両方がこれを読む。"""
    v = WIND_DRAG_REFERENCE_SPEED_MS
    situations = [
        ("向かい風2m/s", 2.0, 0.0),
        ("向かい風4m/s", 4.0, 0.0),
        ("向かい風8m/s", 8.0, 0.0),
        ("追い風4m/s", 4.0, 180.0),
        ("真横4m/s", 4.0, 90.0),
        ("走行速度と同じ追い風", v, 180.0),
    ]
    return {
        situation: round(wind_drag_ratio(wind_speed_ms, wind_direction_deg, 0.0, v), 2)
        for situation, wind_speed_ms, wind_direction_deg in situations
    }


_WIND_DRAG_RATIO_BY_SITUATION = _wind_drag_ratio_by_situation()


_RAIN_MATERIAL_NOTE = (
    "雨量計は0.5mm刻みで、それより弱い雨は観測されません。"
    "出発時刻では延ばさず、地図・道の詳細・ルートのどれでも今の観測を使います。"
)
_RAIN_COVERAGE = CoverageExcluded(
    reason="アメダスの観測から都度引く動的材料で、DBに静的な値を持たない",
    missing_semantics="unknown",
)


# 材料の値（OSMタグ生値）ごとの日本語ラベル対訳表。
# MaterialSpec.value_labelsのdocstring参照——「地図表示と評価は別」という方針に基づき、
# 地図の表示分類（一次属性`highway`の`display_axes`が持つ`DisplayCategorySpec`、
# 意図的に多対一）とは独立した1値1ラベルの専用対訳表。各値の日本語ラベルはOSM wiki
# （Key:highway/Key:surface）の一般的なタグ定義に基づく。MaterialSpecの呼び出し直下へ
# インラインで書くと材料定義ブロックの見通しが悪くなるためここへ分けているだけで、
# 値は`value_labels=`で各MaterialSpecへそのまま渡す。材料をまたぐ別辞書ではない。
_HIGHWAY_VALUE_LABELS: dict[str, str] = {
    "motorway": "高速道路",
    "motorway_link": "高速道路の連絡路",
    "trunk": "国道",
    "trunk_link": "国道の連絡路",
    "primary": "主要地方道",
    "primary_link": "主要地方道の連絡路",
    "secondary": "一般県道",
    "secondary_link": "一般県道の連絡路",
    "tertiary": "2車線の道",
    "tertiary_link": "2車線の道の連絡路",
    "unclassified": "未区分の道路",
    "residential": "住宅街の道路",
    "living_street": "住宅街の道[歩車共存]",
    "service": "施設内通路",
    "road": "種別不明の道路",
    "cycleway": "自転車専用道",
    "path": "小道・遊歩道",
    "footway": "歩道",
    "pedestrian": "歩行者専用道路",
    "bridleway": "乗馬道",
    "steps": "階段",
    "track": "農道・林道",
}

_SURFACE_VALUE_LABELS: dict[str, str] = {
    "asphalt": "アスファルト",
    "paved": "舗装[種別不明]",
    "chipseal": "チップシール舗装",
    "concrete": "コンクリート",
    "concrete:plates": "コンクリート版",
    "concrete:lanes": "コンクリート帯[轍部のみ舗装]",
    "paving_stones": "石畳[切石]",
    "bricks": "レンガ舗装",
    "compacted": "締固め砂利",
    "fine_gravel": "細砂利",
    "gravel": "砂利",
    "pebblestone": "小石敷き",
    "rock": "岩盤",
    "unpaved": "未舗装[種別不明]",
    "dirt": "土",
    "ground": "地面[土・砂利混合]",
    "earth": "土[地表面]",
    "mud": "泥",
    "sand": "砂",
    "grass": "芝・草地",
    "woodchips": "ウッドチップ",
    "sett": "石畳[玉石]",
    "cobblestone": "玉石舗装",
    "unhewn_cobblestone": "玉石舗装[未加工]",
}

#: 呼び名はOSMの定義（Key:tracktype）の路面の中身から付ける。並びは固い路面から柔らかい路面への順。
_TRACKTYPE_VALUE_LABELS: dict[str, str] = {
    "grade1": "1 舗装・固く締まる",
    "grade2": "2 砂利[未舗装]",
    "grade3": "3 砂利と土が半々",
    "grade4": "4 土・草が主",
    "grade5": "5 土・草・砂",
}

_SMOOTHNESS_VALUE_LABELS: dict[str, str] = {
    "excellent": "非常に良好[ロードバイク推奨]",
    "good": "良好",
    "intermediate": "普通",
    "bad": "悪い",
    "very_bad": "かなり悪い",
    "horrible": "劣悪",
    "very_horrible": "極めて劣悪",
    "impassable": "通行不能",
}

# 道の区分を決める事実（タグの値を束ねずに持つ材料）の対訳。値の意味はOSM wikiのKey:access・Key:cycleway・
# Key:segregated・Key:motorroadの定義による。
_ACCESS_VALUE_LABELS: dict[str, str] = {
    "yes": "通ってよい",
    "no": "通行禁止",
    "designated": "通行を指定",
    "permissive": "所有者の許しで通ってよい",
    "dismount": "降りて押して通る",
    "use_sidepath": "並ぶ専用の道を使う",
    "destination": "目的地へ行くときだけ通ってよい",
    "private": "関係者だけ",
}
_CYCLEWAY_VALUE_LABELS: dict[str, str] = {
    "track": "自転車道[車道と分離]",
    "lane": "自転車レーン",
    "shared_lane": "車と共用の帯",
    "share_busway": "バスと共用の帯",
    "opposite_lane": "逆向きの自転車レーン",
    "opposite": "自転車だけ逆向きに通れる",
    "separate": "別の道として描いた自転車道",
    "shoulder": "路肩",
    "no": "なし",
}
#: cyclewayの各タグが道のどちら側を指すか（材料の説明に添える）。タグを足して書き漏らすとimport時に落ちる。
_CYCLEWAY_SIDE_NOTES: dict[str, str] = {
    "cycleway": "",
    "cycleway:left": "のうち、道の形の向きの左側のもの",
    "cycleway:right": "のうち、道の形の向きの右側のもの",
    "cycleway:both": "のうち、両側のもの",
}
_SEGREGATED_VALUE_LABELS: dict[str, str] = {"yes": "歩行者と分けて通る", "no": "歩行者と混ざって通る"}
_MOTORROAD_VALUE_LABELS: dict[str, str] = {"yes": "自動車専用道路", "no": "自動車専用でない"}


def _tag_fact_material(
    material_id: str,
    tag: str,
    label: str,
    meaning: str,
    value_labels: dict[str, str],
    primary_attribute: PrimaryAttributeSpec,
    missing_semantics: MissingSemantics,
) -> MaterialSpec:
    """道の区分を決める事実として、タグの値を区分へ束ねずに持つ材料。タイルにも道路網にも載せ、
    束ね方を変えてもタイルと道路網を作り直さずに済むようにする。"""
    value_sql = normalized_tag_sql(tag)
    return MaterialSpec(
        material_id=material_id,
        label=label,
        description=f"{meaning}OSMのタグ({tag})の値を、区分へ束ねずに持ちます。",
        dtype="categorical",
        tile_property=material_id,
        primary_attribute=primary_attribute,
        value_labels=value_labels,
        value_sql=value_sql,
        coverage=WayMaterialCoverageSpec(
            missing_condition=f"{value_sql} IS NULL",
            source=f"OSM wayのタグ {tag}",
            missing_semantics=missing_semantics,
        ),
    )


def _landcover_description(cls: LandcoverClass) -> str:
    """表示名だけでは何を含むか読み取れないので、地図の凡例と同じ分類の説明を添える。"""
    return (
        "衛星画像の土地被覆データ（Esri×Impact Observatory）から算出した、"
        f"道路周囲{LANDCOVER_RING_OUTER_M:g}mリング内の{cls.label}の割合(%)。{cls.label}は、{cls.description}"
    )


#: コードが名指しで読む材料のid。カタログのキーにも同じ定数を使う——綴りを別々に書くと、
#: ずれたときに読む側が材料を見つけられず、黙って欠損として扱う。
GRADIENT_PERCENT = "gradient_percent"
WIND_DRAG_RATIO = "wind_drag_ratio"
ACCIDENT_COUNT_PER_KM_YEAR = "accident_count_per_km_year"


# 軸が参照する材料と、MVTタイルへ焼き込み済みだが評価軸には未使用の生データの両方を持つ
# （モジュール冒頭の注記参照）。
MATERIAL_CATALOG: dict[str, MaterialSpec] = {
    GRADIENT_PERCENT: MaterialSpec(
        material_id=GRADIENT_PERCENT,
        label="勾配[符号付き]",
        description="国土地理院の標高データから算出した進行方向の勾配（%）。登り坂はプラス、下り坂はマイナスです。",
        dtype="numeric",
        unit="%",
        # 進行方向で符号が変わる（登りプラス・下りマイナス）ため、1本のWayに往復2つの値を
        # 持ちうる。方向を持たないMVTプロパティ1個には焼き込めないので、地図へは
        # `services/gradient_way_service.py`のフィーチャー→値配信で乗せる。
        tile_property=None,
        primary_attribute=ATTR_ELEVATION,
        value_sql="em.average_grade",
        coverage=EdgeMaterialCoverageSpec(
                present_condition="em.average_grade IS NOT NULL",
                source="edge_elevation.average_grade の有無",
                missing_semantics="unknown",
            ),
    ),
    WIND_DRAG_RATIO: MaterialSpec(
        material_id=WIND_DRAG_RATIO,
        label="風の追加負荷(倍率)",
        description=(
            "風（気象庁の数値予報モデルの計算値。予報ではなく誤差を含みうる）・進行方向・想定速度から、"
            "相対風速の二乗則で求めた空気抵抗の増分"
            f"（{_WIND_REFERENCE_SPEED_LABEL}で無風のときの空気抵抗を1とする倍率）。プラス=向かい風で重くなる、マイナス=追い風で楽になる、"
            "真横の風は小さなプラス。同じ風でも速く走るほど値が大きくなります。"
            f"目安（{_WIND_REFERENCE_SPEED_LABEL}）: "
            + "、".join(f"{situation}→{ratio}" for situation, ratio in _WIND_DRAG_RATIO_BY_SITUATION.items())
            + "。ルートでは各区間を通る見込みの時刻の風を使い、地図では選んだ時刻の風と指定した走行の向きを使います。"
        ),
        dtype="numeric",
        # 気象は動的データ（時刻依存）のためタイルに焼き込めない（`domain/wind.py:
        # wind_drag_ratio_array`がリクエスト時に計算する）。対応する一次属性も持たない
        # （動的気象は`PRIMARY_ATTRIBUTES`の対象外）。
        tile_property=None,
        source="request",
        coverage=CoverageExcluded(
            reason="時刻ごとの風の予報（数値予報モデルの計算値）・想定速度から都度計算する動的材料で、DBに静的な値を持たない",
            missing_semantics="unknown",
        ),
    ),
    # --- 雨の材料。`domain/rain.py: RAIN_WINDOW_HOURS`（窓の長さの一覧）から生成する ---
    # 値は最寄りの雨量計の観測（`domain/rain.py: rain_material_columns`）で、地図へは専用の配信、
    # ルートへは探索範囲の静的スコア行列の列として届く。
    **{
        rain_window_material_id(hours): MaterialSpec(
            material_id=rain_window_material_id(hours),
            label=f"過去{hours}時間の雨量",
            description=(
                f"最寄りのアメダス雨量計で観測した、直近の正時までの{hours}時間の降水量の合計（mm）。"
                "窓の中に欠測の1時間があれば値を持ちません。" + _RAIN_MATERIAL_NOTE
            ),
            dtype="numeric",
            unit="mm",
            tile_property=None,
            source="observation",
            coverage=_RAIN_COVERAGE,
        )
        for hours in RAIN_WINDOW_HOURS
    },
    HOURS_SINCE_RAIN: MaterialSpec(
        material_id=HOURS_SINCE_RAIN,
        label="雨が止んでからの時間",
        description=(
            f"最寄りのアメダス雨量計で、雨（1時間に{PRECIPITATION_MIN_MM:g}mm以上）を観測した最後の1時間が"
            "終わってからの時間（1時間刻み）。直近の1時間に雨があれば0。"
            f"{RAIN_HISTORY_HOURS}時間さかのぼって雨が無ければ{RAIN_HISTORY_HOURS}（{RAIN_HISTORY_HOURS}時間以上）。"
            "雨を見つける前に欠測の1時間があれば値を持ちません。" + _RAIN_MATERIAL_NOTE
        ),
        dtype="numeric",
        unit="時間",
        tile_property=None,
        source="observation",
        coverage=_RAIN_COVERAGE,
    ),
    # --- 土地被覆のクラス別の割合。`domain/landcover.py: LANDCOVER_CLASSES`から生成する ---
    **{
        cls.percent_field: MaterialSpec(
            material_id=cls.percent_field,
            label=f"{cls.label}被覆率",
            description=_landcover_description(cls),
            dtype="numeric",
            unit="%",
            tile_property=None,
            primary_attribute=ATTR_LANDCOVER,
            value_sql=landcover_value_sql(landcover_key(cls.percent_field)),
            coverage=_landcover_coverage(landcover_key(cls.percent_field)),
        )
        for cls in LANDCOVER_CLASSES
    },
    "intersection_count_per_km": MaterialSpec(
        material_id="intersection_count_per_km",
        label="交差点密度",
        description=f"接続する道路が{INTERSECTION_DEGREE_THRESHOLD}本以上ある交差点の1kmあたりの発生回数。",
        dtype="numeric",
        unit="回/km",
        additive=True,
        total_unit="回",
        tile_property=None,
        primary_attribute=ATTR_INTERSECTION,
        value_sql=per_km_value_sql("em.intersection_count"),
        coverage=_EDGE_COUNTS_COVERAGE,
    ),
    ACCIDENT_COUNT_PER_KM_YEAR: MaterialSpec(
        material_id=ACCIDENT_COUNT_PER_KM_YEAR,
        label="事故密度",
        description="警察庁の事故データに基づく、1kmあたり・1年あたりの人身事故件数。",
        dtype="numeric",
        unit="件/(km・年)",
        additive=True,
        tile_property=None,
        primary_attribute=ATTR_ACCIDENT_POINT,
        value_sql=f"CASE WHEN :accident_years > 0 THEN {per_km_value_sql('em.accident_count')} / :accident_years END",
        coverage=_EDGE_COUNTS_COVERAGE,
    ),
    "lit": MaterialSpec(
        material_id="lit",
        label="街灯あり",
        description=f"OSMの街灯タグ({tag_note(*_LIT_YES)})に該当する区間はtrue。タグ不在はfalse（街灯なし扱い）。",
        dtype="boolean",
        tile_property=None,
        primary_attribute=ATTR_LIT,
        value_sql=tag_is_value_sql(*_LIT_YES),
        coverage=WayMaterialCoverageSpec(
                missing_condition=f"{LIT_NORMALIZED_SQL} IS NULL",
                source="OSM wayのタグ lit（タグ不在は街灯なし扱い）",
                missing_semantics="definite",
            ),
    ),
    "has_tunnel": MaterialSpec(
        material_id="has_tunnel",
        label="トンネル",
        description=f"OSMのトンネルタグが地中を通るもの({tag_note('tunnel', *TUNNEL_STRUCTURE_VALUES)})に該当する区間はtrue。",
        dtype="boolean",
        tile_property="tunnel",
        primary_attribute=ATTR_TUNNEL,
        value_sql=IS_TUNNEL_SQL,
        coverage=WayMaterialCoverageSpec(
                missing_condition=f"{TUNNEL_NORMALIZED_SQL} IS NULL",
                source="OSM wayのタグ tunnel（タグ不在は非該当扱い）",
                missing_semantics="definite",
            ),
    ),
    # --- MVTタイルに焼き込み済みだが評価軸には未使用の生データ ---
    "bridge": MaterialSpec(
        material_id="bridge",
        label="橋・高架",
        description=f"OSMの橋・高架タグが地面から浮いたもの({tag_note('bridge', *BRIDGE_STRUCTURE_VALUES)})に該当する区間はtrue。",
        dtype="boolean",
        tile_property="bridge",
        value_sql=IS_BRIDGE_SQL,
        coverage=WayMaterialCoverageSpec(
                missing_condition=f"{BRIDGE_NORMALIZED_SQL} IS NULL",
                source="OSM wayのタグ bridge（タグ不在は非該当扱い）",
                missing_semantics="definite",
            ),
    ),
    "motor_vehicle_no": MaterialSpec(
        material_id="motor_vehicle_no",
        label="自動車通行不可",
        description=f"OSMのタグ({tag_note(*_MOTOR_VEHICLE_NO)})から判定した、自動車が通行できない区間かどうか。",
        dtype="boolean",
        # OSMのmotor_vehicleタグがnoの区間（内部軸
        # [domain/axis_definitions.py]でも参照される材料だが、軸合成前の生の真偽値自体は
        # 独立して材料登録していなかった）。
        tile_property=None,
        primary_attribute=ATTR_MOTOR_VEHICLE_ACCESS,
        value_sql=tag_is_value_sql(*_MOTOR_VEHICLE_NO),
        coverage=WayMaterialCoverageSpec(
                missing_condition=f"{MOTOR_VEHICLE_NORMALIZED_SQL} IS NULL",
                source="OSM wayのタグ motor_vehicle（タグ不在は通行可扱い）",
                missing_semantics="definite",
            ),
    ),
    "oneway": MaterialSpec(
        material_id="oneway",
        label="一方通行",
        description=f"OSMのタグから判定した一方通行の区間かどうか。{DIVIDED_ROAD_NOTE}の片側は一方通行に数えない。",
        dtype="boolean",
        tile_property="oneway",
        primary_attribute=ATTR_ONEWAY,
        value_sql=oneway_material_sql("wm.direction", "wm.divided"),
        coverage=CoverageExcluded(
            reason="way_directions.directionはNOT NULL列で、タグ不在は双方向(both)に解決済み（欠損の概念が無い）",
            missing_semantics="definite",
        ),
    ),
    "maxspeed_kmh": MaterialSpec(
        material_id="maxspeed_kmh",
        label="制限速度",
        description="OSMの制限速度タグ(maxspeed)から解析した制限速度（km/h）。",
        dtype="numeric",
        unit="km/h",
        tile_property=None,
        primary_attribute=ATTR_MAXSPEED,
        value_sql=MAXSPEED_KMH_CASE_SQL,
        coverage=WayMaterialCoverageSpec(
                missing_condition=f"({MAXSPEED_KMH_CASE_SQL}) IS NULL",
                source="OSM wayのタグ maxspeed（数値として解釈できない値も欠損に含む）",
                missing_semantics="unknown",
            ),
    ),
    "lanes_count": MaterialSpec(
        material_id="lanes_count",
        label="車線数",
        description="OSMの車線数タグ(lanes)から解析した車線数。",
        dtype="numeric",
        tile_property=None,
        primary_attribute=ATTR_LANES,
        value_sql=LANES_COUNT_CASE_SQL,
        coverage=WayMaterialCoverageSpec(
                missing_condition=f"({LANES_COUNT_CASE_SQL}) IS NULL",
                source="OSM wayのタグ lanes（数値として解釈できない値も欠損に含む）",
                missing_semantics="unknown",
            ),
    ),
    "highway": MaterialSpec(
        material_id="highway",
        label="道路種別",
        description="OSMの道路種別タグ(highway)の生値（例: residential/primary/cycleway等）。値ごとに個別のスコアを設定できます。",
        dtype="categorical",
        # OSMのhighwayタグ生値（motorway/trunk/primary/secondary/tertiary/residential/
        # living_street/unclassified/track/cycleway/path/footway等）。取込プロファイル
        # （`batch/source_profile.yaml: osm_way.rows`）で許可された値のみ実際に現れる。
        # 正準の閉じた値集合はこのプロジェクトで管理していない（OSMタグの生値のため）。
        tile_property="highway",
        primary_attribute=ATTR_HIGHWAY,
        value_labels=_HIGHWAY_VALUE_LABELS,
        value_sql=HIGHWAY_SQL,
        coverage=CoverageExcluded(reason=_HIGHWAY_ALWAYS_PRESENT, missing_semantics="unknown"),
    ),
    "surface": MaterialSpec(
        material_id="surface",
        label="路面種別",
        description="OSMの路面種別タグ(surface)の生値（例: asphalt/gravel等）。区分（路面の区分）より細かく、タグの値ごとにスコアを設定したい場合に使います。",
        dtype="categorical",
        # タグの値そのもの（正規化: lower/btrim）。
        tile_property="surface",
        primary_attribute=ATTR_SURFACE,
        value_labels=_SURFACE_VALUE_LABELS,
        value_sql=SURFACE_NORMALIZED_SQL,
        coverage=WayMaterialCoverageSpec(
                missing_condition=f"{SURFACE_NORMALIZED_SQL} IS NULL",
                source="OSM wayのタグ surface",
                missing_semantics="unknown",
            ),
    ),
    # 自転車インフラの分類を、評価軸ではなく材料の側で正規化したフラグ群。軸はこれらを
    # 重み付き線形結合するだけで、タグの読み方を知らない。それぞれ専用のtile_propertyを
    # 持ち、MVTタイルへ焼き込む。
    "highway_is_cycleway": MaterialSpec(
        material_id="highway_is_cycleway",
        label="道路種別が自転車専用道",
        description=f"道路種別(highway)自体が自転車専用道({tag_note('highway', CYCLEWAY_HIGHWAY)})かどうか。",
        dtype="boolean",
        tile_property=None,
        # 判定式はhighway生タグを見るが、意味的にはこの群の他の材料と同じ「自転車走行環境の
        # 分類」という1つのまとまりのため、cycleway_has_track等と同じ一次属性へ寄せる。
        primary_attribute=ATTR_CYCLEWAY,
        value_sql=f"{HIGHWAY_SQL} = '{CYCLEWAY_HIGHWAY}'",
        coverage=CoverageExcluded(reason=_HIGHWAY_ALWAYS_PRESENT, missing_semantics="definite"),
    ),
    "cycleway_has_track": MaterialSpec(
        material_id="cycleway_has_track",
        label="自転車道(track)を併設",
        description=f"車道と分離された自転車道({tag_note('cycleway', *CYCLEWAY_TRACK_VALUES)})を併設しているかどうか。",
        dtype="boolean",
        tile_property=None,
        primary_attribute=ATTR_CYCLEWAY,
        value_sql=cycleway_has_value_sql(*CYCLEWAY_TRACK_VALUES),
        coverage=_CYCLEWAY_TAGS_COVERAGE,
    ),
    "cycleway_has_lane": MaterialSpec(
        material_id="cycleway_has_lane",
        label="自転車レーン(lane)を併設",
        description=f"車道上に線で区切られた自転車レーン({tag_note('cycleway', *CYCLEWAY_LANE_VALUES)})を併設しているかどうか。",
        dtype="boolean",
        tile_property=None,
        primary_attribute=ATTR_CYCLEWAY,
        value_sql=cycleway_has_value_sql(*CYCLEWAY_LANE_VALUES),
        coverage=_CYCLEWAY_TAGS_COVERAGE,
    ),
    "cycleway_has_shared": MaterialSpec(
        material_id="cycleway_has_shared",
        label="バス共用等の自転車レーンを併設",
        description=(
            "バス専用レーン共用など、簡易な自転車レーン"
            f"({tag_note('cycleway', *CYCLEWAY_SHARED_VALUES)})を併設しているかどうか。"
        ),
        dtype="boolean",
        tile_property=None,
        primary_attribute=ATTR_CYCLEWAY,
        value_sql=cycleway_has_value_sql(*CYCLEWAY_SHARED_VALUES),
        coverage=_CYCLEWAY_TAGS_COVERAGE,
    ),
    "shared_pedestrian_path": MaterialSpec(
        material_id="shared_pedestrian_path",
        label="歩行者自転車共用道",
        description=(
            "車道と分離された歩行者道のうち、自転車の通行が認められている区間"
            f"（河川敷サイクリングロード等、{SHARED_PEDESTRIAN_PATH_NOTE}）かどうか。"
        ),
        dtype="boolean",
        tile_property=None,
        primary_attribute=ATTR_CYCLEWAY,
        value_sql=tag_absent_is_false_sql(SHARED_PEDESTRIAN_PATH_SQL),
        coverage=WayMaterialCoverageSpec(
                missing_condition=f"{BICYCLE_NORMALIZED_SQL} IS NULL",
                source=f"OSM wayのタグ bicycle（{SHARED_PEDESTRIAN_PATH_NOTE}で判定、タグ不在は非該当扱い）",
                missing_semantics="definite",
            ),
    ),
    # --- 道の区分を決める事実（タグの値を束ねずに持つ）。道の区分の条件はこれらを読む ---
    "bicycle": _tag_fact_material(
        "bicycle", "bicycle", "自転車の通行", "自転車が通ってよいか（禁止・指定・許可等）。",
        _ACCESS_VALUE_LABELS, ATTR_CYCLEWAY, "unknown",
    ),
    "foot": _tag_fact_material(
        "foot", "foot", "歩行者の通行", "歩行者が通ってよいか（禁止・指定・許可等）。",
        _ACCESS_VALUE_LABELS, ATTR_CYCLEWAY, "unknown",
    ),
    "segregated": _tag_fact_material(
        "segregated", "segregated", "歩行者との分離", "自転車と歩行者が通る道で、通る所が分けられているか。",
        _SEGREGATED_VALUE_LABELS, ATTR_CYCLEWAY, "unknown",
    ),
    "motorroad": _tag_fact_material(
        "motorroad", "motorroad", "自動車専用道路", "高速道路でない道が、自動車専用の標識を持つか。",
        _MOTORROAD_VALUE_LABELS, ATTR_HIGHWAY, "definite",
    ),
    **{
        tag.replace(":", "_"): _tag_fact_material(
            tag.replace(":", "_"), tag, f"自転車の通り道[{tag}]",
            f"道に沿う自転車の通り道（レーン・分離した自転車道・共用の帯等）{_CYCLEWAY_SIDE_NOTES[tag]}。",
            _CYCLEWAY_VALUE_LABELS, ATTR_CYCLEWAY, "definite",
        )
        for tag in CYCLEWAY_TAG_NAMES
    },
    "smoothness": MaterialSpec(
        material_id="smoothness",
        label="路面の状態",
        description=(
            f"OSMの路面状態タグ(smoothness)の生値（{next(iter(_SMOOTHNESS_VALUE_LABELS))}〜"
            f"{next(reversed(_SMOOTHNESS_VALUE_LABELS))}）。同じ路面種別(surface)でも実際の荒れ具合を区別したい場合に使います。"
        ),
        dtype="categorical",
        # 値の表は良い順に並べる（説明の範囲が表の最初と最後から組まれる）。surfaceが路面「種別」なのに
        # 対し、smoothnessは実際の走行感（同じasphaltでも荒れ具合が違う等）。
        tile_property="smoothness",
        value_labels=_SMOOTHNESS_VALUE_LABELS,
        value_sql=SMOOTHNESS_NORMALIZED_SQL,
        coverage=WayMaterialCoverageSpec(
                missing_condition=f"{SMOOTHNESS_NORMALIZED_SQL} IS NULL",
                source="OSM wayのタグ smoothness",
                missing_semantics="unknown",
            ),
    ),
    "tracktype": MaterialSpec(
        material_id="tracktype",
        label="農道・林道の等級",
        description=(
            "OSMの農道・林道の路面等級タグ(tracktype)の値"
            f"（{next(iter(_TRACKTYPE_VALUE_LABELS))}={next(iter(_TRACKTYPE_VALUE_LABELS.values()))}〜"
            f"{next(reversed(_TRACKTYPE_VALUE_LABELS))}={next(reversed(_TRACKTYPE_VALUE_LABELS.values()))}）。"
            "路面種別(surface)とは別のタグです。"
        ),
        dtype="categorical",
        tile_property="tracktype",
        primary_attribute=ATTR_TRACKTYPE,
        value_labels=_TRACKTYPE_VALUE_LABELS,
        value_sql=TRACKTYPE_NORMALIZED_SQL,
        coverage=WayMaterialCoverageSpec(
                missing_condition=f"{TRACKTYPE_NORMALIZED_SQL} IS NULL",
                source="OSM wayのタグ tracktype",
                missing_semantics="unknown",
            ),
    ),
    # --- 停止要因POIの種別別密度。`domain/traffic.py: POI_COUNT_KINDS`から生成する ---
    # 材料を1件ずつ手書きせず一覧から作るため、キーを増やすときに触るのはその一覧だけで済む。
    **{
        poi_density_material_id(kind): MaterialSpec(
            material_id=poi_density_material_id(kind),
            label=f"{label}の密度",
            description=f"進行する道路上にある{label}の、1kmあたりの数。",
            dtype="numeric",
            unit="回/km",
            additive=True,
            total_unit="回",
            tile_property=None,
            value_sql=poi_density_value_sql(kind),
            # 行があれば載っていないキーは0件と確定できる（欠損は行そのものの不在だけ）。
            coverage=_EDGE_COUNTS_COVERAGE,
            primary_attribute=ATTR_STOP_POI,
        )
        for kind, label in POI_COUNT_KINDS.items()
    },
}



def material_spec(material_id: str) -> MaterialSpec | None:
    """材料idの宣言。`MATERIAL_CATALOG`の材料と、道の区分から作る材料（`class:<分け方>`、今の区分の分け方ごとに1つ）を引く。
    無い材料idにはNoneを返す。"""
    spec = MATERIAL_CATALOG.get(material_id)
    if spec is not None:
        return spec
    from app.domain.road_classes import class_material_spec  # 区分は材料の宣言を読むので、引くときにだけ読む

    return class_material_spec(material_id)


def known_material_spec(material_id: str) -> MaterialSpec:
    """在ると分かっている材料idの宣言（`material_spec`）。無ければKeyError。"""
    spec = material_spec(material_id)
    if spec is None:
        raise KeyError(material_id)
    return spec


def all_material_specs() -> list[MaterialSpec]:
    """`MATERIAL_CATALOG`の材料と、今の区分から作る材料の全部。"""
    from app.domain.road_classes import class_material_specs

    return [*MATERIAL_CATALOG.values(), *class_material_specs()]


def is_known_material(material_id: str) -> bool:
    return material_spec(material_id) is not None


def material_dtype(material_id: str) -> MaterialDType | None:
    """材料idのdtype（`MaterialDType`）。無い材料idにはNoneを返す。"""
    spec = material_spec(material_id)
    return spec.dtype if spec is not None else None


def material_array_columns() -> tuple[tuple[str, ...], tuple[str, ...]]:
    """行列ごとの材料idと、その並び（数値・分類）。真偽の材料は数値の行列へ1.0/0.0で載り、
    欠損（道の生データが無い区間等）はNaNで持つ——真偽の行列に載せると欠損を持てず、
    「不明」が「非該当」に化ける。

    行列の列がどう並ぶかの唯一の定義。組み立てる側と読む側が別々に並べると、
    材料を1つ足したときに列の意味が静かにずれる。
    """
    ids = sorted(material_value_sql())
    return (
        tuple(m for m in ids if MATERIAL_CATALOG[m].dtype != "categorical"),
        tuple(m for m in ids if MATERIAL_CATALOG[m].dtype == "categorical"),
    )


def materials_of_source(source: MaterialSource) -> frozenset[str]:
    """出どころが`source`の材料id。"""
    return frozenset(material_id for material_id, spec in MATERIAL_CATALOG.items() if spec.source == source)


def material_value_sql() -> dict[str, str]:
    """材料id→値を求めるSQL式。カタログから導く（別の辞書を持たない）。"""
    return {
        material_id: spec.value_sql
        for material_id, spec in MATERIAL_CATALOG.items()
        if spec.value_sql is not None
    }


def segment_material_ids() -> frozenset[str]:
    """同じ道でも区間ごとに値が違いうる材料（値式が区間ごとの値を読む材料。`material_sql.py: reads_segment_values`）。"""
    return frozenset(material_id for material_id, sql in material_value_sql().items() if reads_segment_values(sql))


def material_coverage_specs() -> dict[str, WayMaterialCoverageSpec | EdgeMaterialCoverageSpec]:
    """欠損率を測る材料id→測り方。カタログから導く（別の辞書を持たない）。"""
    return {
        material_id: spec.coverage
        for material_id, spec in MATERIAL_CATALOG.items()
        if not isinstance(spec.coverage, CoverageExcluded)
    }


def material_coverage_exclusions() -> dict[str, str]:
    """欠損率を測らない材料id→その理由。"""
    return {
        material_id: spec.coverage.reason
        for material_id, spec in MATERIAL_CATALOG.items()
        if isinstance(spec.coverage, CoverageExcluded)
    }


def display_axis_material(attr: PrimaryAttributeSpec, tile_property: str) -> MaterialSpec | None:
    """一次属性の表示の軸（タイルのプロパティ`tile_property`）の値をタイルへ載せる材料。無ければNone。"""
    for spec in MATERIAL_CATALOG.values():
        if spec.primary_attribute is attr and spec.tile_property == tile_property:
            return spec
    return None


def display_axis_missing_semantics(attr: PrimaryAttributeSpec, tile_property: str) -> MissingSemantics | None:
    """一次属性の表示の軸（タイルのプロパティ`tile_property`）の値が欠けたときの意味。その値をタイルへ載せる材料の
    宣言から引く——`unknown`なら値の無い道がタイルに現れうる（地図は「不明」として破線で出す）、`definite`なら
    タグの不在も確定した値として載る。載せる材料が無ければNone。"""
    spec = display_axis_material(attr, tile_property)
    return None if spec is None else spec.coverage.missing_semantics


def tile_column_sql(spec: MaterialSpec) -> str:
    """材料をタイルの列へ焼く式。値式を包むだけで、値の求め方を書かない——地図と評価が同じ式を読む。

    真偽は該当だけを`true`で載せ、非該当はNULLにしてフィーチャーからキーを省く（タイルが軽くなる）。
    それ以外は値をそのまま載せる。
    """
    value = f"({spec.value_sql})"
    if spec.dtype == "boolean":
        return f"CASE WHEN {value} THEN true END"
    return value


def material_tile_columns() -> dict[str, str]:
    """タイルのプロパティ名→焼く式。`tile_property`を持つ全材料から導く（別に列を並べない）。"""
    return {
        spec.tile_property: tile_column_sql(spec)
        for spec in MATERIAL_CATALOG.values()
        if spec.tile_property is not None
    }

