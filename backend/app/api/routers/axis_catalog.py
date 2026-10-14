"""軸カタログの公開読み取りAPI。

一般向けのルート設定画面が、評価軸の一覧
（label/description/category/default_weight）を取得するための読み取り専用・認可不要の
エンドポイント。書き込みは`api/routers/axis_admin.py`（認可必須）が担う。

軸スタジオが管理API経由でDBへ書き込んだ軸も、`AXIS_DEFINITIONS`のpush型更新
（services/axis_registry_service.py）により、コード変更・再デプロイなしにここへ反映される。
ビルド時の生成物は軸を持たない（`export_openapi.py`が`domain/registry.py`から書き出すのは
一次属性の語彙まで）ため、フロントが軸を知る経路はこのAPIだけ。

**公開済み軸のみを返す**: `is_published=False`（下書き）の軸は
一般ユーザーの目に触れさせない（下書き軸が一般UIに漏れると、まだ検証・命名が
固まっていない軸を一般ユーザーが選んでしまい、その後の破壊的変更・削除ができなく
なる——公開の意味が失われる）。下書き軸の一覧・編集は認可必須の
`GET /api/admin/axis-definitions`（軸スタジオ）側で行う。

**`map_paint`フィールド**: `domain/map_paint.py: map_paint()`
（プロセス内メモリのみを見る純粋関数、DB/IO無し）を軸ごとに呼んで含める。これにより、
軸スタジオでの公開操作（is_publishedの切替）が、地図レイヤーのramp表示へ**再デプロイ
なしに即座に**反映される（docs/records/decisions/t308-axis-map-display-auto-derivation.md参照）。

**`tile_runtime_scales`**: 地図表示の導出は、タイルの生値を材料の値へ換算する係数が実行時に
しか決まらない材料（`MaterialSpec.tile_property_runtime_scale`）も対象に含めるが、係数の源
（事故の収録年）はDBにしか無いため、`domain/axis_display.py`の純粋関数では求められない。
本エンドポイントがリクエスト毎に1回だけ地域サービス（`services/region_service.py`）から収録年を読み、係数は
`domain/material_catalog.py: tile_runtime_scales`が材料の宣言から導く。フロントのJS式ビルダーが
これを取得しタイル生値に掛け合わせる。
"""

from fastapi import APIRouter, Depends

from app.api.dependencies import get_region_service
from app.domain.axis_definitions import (
    AXIS_DEFINITIONS,
    AxisCategory,
    AxisDefinition,
    BreakpointLinearShape,
    TimeScope,
    averages_density,
    primary_attribute_ids_for,
    published_axis_definitions,
    weather_layer_groups_for,
)
from app.domain.material_catalog import MATERIAL_CATALOG, tile_runtime_scales
from app.domain.axis_raw_value import (
    AxisMaterialBreakdownEntry,
    RawValueUnits,
    axis_material_breakdown,
    raw_value_units,
)
from app.domain.dynamic_way_values import WayValueConditionName
from app.domain.map_paint import MapPaint, map_paint
from app.domain.tuning import client_tuning_values
from app.services.dedicated_way_values import dedicated_way_value_layers
from app.services.region_service import RegionService
from app.domain.strict_model import StrictModel

router = APIRouter()


def _density_terms(definition: AxisDefinition) -> list["AxisDensityTerm"] | None:
    """密度の軸（`domain/axis_definitions.py: averages_density`）の項を、軸定義の並びのまま。密度の軸でなければNone。"""
    if not averages_density(definition):
        return None
    shape = definition.shape
    assert isinstance(shape, BreakpointLinearShape)
    return [
        AxisDensityTerm(material_id=term.material, label=MATERIAL_CATALOG[term.material].label, weight=term.weight)
        for term in shape.terms
    ]


class AxisDensityTerm(StrictModel):
    """密度の軸の項1件。軸の生値は、項の材料（1kmあたりの回数・件数）にこの重みを掛けて足したもの。"""

    material_id: str
    #: 材料の表示名（`MaterialSpec.label`）。
    label: str
    #: 軸定義に書いた重みのまま（正規化しない）。0の項も並べる——材料の点が地図に出ても、数に入らないことを言える。
    weight: float


class AxisCatalogEntry(StrictModel):
    axis_id: str
    label: str
    description: str
    category: AxisCategory
    default_weight: float
    # 未設定はフロント側の汎用のアイコンに委ねる（domain/axis_definitions.py: AxisDefinition.icon_idのdocstring参照）。
    icon_id: str | None
    # この軸が参照する材料を、対応する一次属性id（domain/registry.py:
    # PrimaryAttributeSpec.attr_id。ビルド時の生成物が配る一次属性と同じ名前空間）へ
    # 解決したもの（重複除去、対応が無い材料[動的気象・未登録一次属性]・他の軸を参照する
    # 材料[階層構造]は除く）。軸と一次属性レイヤーの対応を、軸idで分岐せずに引けるよう
    # 軸スタジオの公開軸にも同じ形で配る。
    primary_attribute_ids: list[str]
    # この軸の材料の元データを描く気象のチップ（`domain/axis_definitions.py: weather_layer_groups_for`）。
    # 一次属性を持たない動的な材料（風等）は`primary_attribute_ids`に現れないため、こちらが運ぶ。
    weather_layer_groups: list[str]
    # ルート未確定時の地図がこの軸を配信の値で塗るかの宣言（domain/axis_definitions.py:
    # AxisDefinition.dedicated_way_value_layerのdocstring参照）。
    # 受け取る側が、axis_idの文字列比較ではなくこのフィールドで地図レイヤー・取得の対象を決めるための宣言。
    dedicated_way_value_layer: bool
    # 地図がこの軸について塗るもの——塗る値・単位・段の境界・凡例の目盛り・タイルの塗り・段の体感ラベル
    # （domain/map_paint.py: map_paint）。ルート確定前の塗り・ルート確定後のルート線色分け・凡例のどれもこれに従う。
    map_paint: MapPaint
    # 生値と総量の単位（`domain/axis_raw_value.py: raw_value_units`）。ルート結果は得点の隣に
    # この単位で生値を出す。**総量を出しても読み手の判断が変わらない軸は総量の単位がnull**
    # （「約3322度曲がる」には比べる尺度が無い）。フロントは単位の綴りから総量の可否を判断しない。
    raw_value_units: RawValueUnits
    # 生値の単位が定まらない軸の内訳（`domain/axis_raw_value.py: axis_material_breakdown`）。
    # 得点だけでは軸単体で経路を判断できないため、材料まで分解して較正に依存しない
    # 絶対の事実を出す。
    # 並びは正規化重みの降順で、フロントは先頭から順に出す（並べ替えを持たない）。
    material_breakdown: list[AxisMaterialBreakdownEntry]
    # 密度の軸（`domain/axis_definitions.py: averages_density`）の項。密度の軸でなければnull。
    # 地図はこれがある軸を、塗った線ではなく材料の点と項の重みで見せる。
    density_terms: list[AxisDensityTerm] | None
    # 配信（`GET /api/region/dynamic-way-values/{axis_id}`）へ地図がこの軸について
    # 載せるクエリパラメータの名前（`services/dedicated_way_values.py: DedicatedWayValueLayer`。
    # 軸の葉の材料を配るサービスが受け取る条件の型から導く）。条件の要らない軸は空。受け取る側が
    # 「どの軸の取得に時刻・向き・想定速度を添えるか」を、axis_idで分岐せずここから決めるために配る。
    dynamic_way_value_conditions: list[WayValueConditionName]
    # 配信が、走行方位しだいで値の決まらない道（値がnull）を返しうるか
    # （`services/dedicated_way_values.py: DedicatedWayValueLayer`）。trueの軸だけ、
    # 地図の凡例が「向きで決まらない」の行を持つ（返さない軸に出すと、どの道も入らない行になる）。
    dynamic_way_value_undetermined_by_bearing: bool
    # 重みが効く時間帯（`domain/axis_definitions.py: AxisDefinition`の`time_scope`）。"always"以外の軸は、
    # その時間帯に通る区間でだけ効く。周りの道は通過する時刻を持たないので、受け取る側が地図の色の前提を
    # axis_idで分岐せずここから決めるために配る。
    time_scope: TimeScope


class AxisCatalogResponse(StrictModel):
    axes: list[AxisCatalogEntry]
    # タイルのプロパティ名→実行時にしか決まらない換算係数（タイル生値に掛けると材料の値になる倍率、
    # `domain/material_catalog.py: tile_runtime_scales`）。`TileInputSpec.needs_runtime_scale=True`な
    # tile_inputのタイル生値へ、受け取る側が`property`で引いて掛ける。
    tile_runtime_scales: dict[str, float] = {}
    # フロントが使う較正値（id → いま効いている値、`domain/tuning.py`が宣言）。管理画面から
    # 変えた値を**再デプロイなしに**画面へ届けるため、起動時に1回取るこのカタログへ相乗り
    # させる（ビルド時生成物のroute-generate-config.jsonが持つ既定値は、画面がidの型にだけ使い、値は読まない）。
    client_tuning: dict[str, float] = {}
    # 配信するタイルの世代（系統名 → `<派生の世代>.<生データの世代>-<形の署名>`、`services/
    # tile_version_service.py`）。フロントはこれをタイルURLのクエリへ入れてブラウザの
    # キャッシュを分ける。**ビルド時生成物では配れない**——バッチが中身を作り直しても
    # デプロイは起きないため、次のデプロイまで古い値を配り続ける。
    tile_versions: dict[str, str] = {}
    # 事故データの収録年（今の事故の数を数えた取込の宣言そのもの）。地図の説明文が範囲を書くために
    # 使う。**表示側に持たせない**——文字列で持つと取り込み直したときに黙って食い違う。
    accident_years: list[int] = []


@router.get("/api/axis-catalog", response_model=AxisCatalogResponse)
async def get_axis_catalog(region_service: RegionService = Depends(get_region_service)) -> AxisCatalogResponse:
    # AXIS_DEFINITIONSは常に最新（起動時＋管理API書き込み直後にin-place更新済み、
    # services/axis_registry_service.py参照）のため、DBへは触れずプロセス内の値を
    # そのまま返す（評価ホットパスと同じ同期アクセス方式）。map_paint()・
    # primary_attribute_ids_for()も同様にプロセス内メモリだけを見る純粋関数のため、
    # リクエスト毎に呼んでもコストは無視できる。事故の収録年と、それから導く換算係数・タイルの世代だけがDBを見る。
    accident_years = await region_service.get_accident_years()
    tile_versions = await region_service.tile_versions()
    way_value_layers = dedicated_way_value_layers()

    return AxisCatalogResponse(
        client_tuning=client_tuning_values(),
        accident_years=accident_years,
        tile_versions=tile_versions,
        axes=[
            AxisCatalogEntry(
                axis_id=definition.axis_id,
                label=definition.label,
                description=definition.description,
                category=definition.category,
                default_weight=definition.default_weight,
                icon_id=definition.icon_id,
                primary_attribute_ids=primary_attribute_ids_for(definition),
                weather_layer_groups=weather_layer_groups_for(definition),
                dedicated_way_value_layer=definition.dedicated_way_value_layer,
                map_paint=map_paint(definition),
                raw_value_units=raw_value_units(definition),
                material_breakdown=axis_material_breakdown(definition, AXIS_DEFINITIONS),
                density_terms=_density_terms(definition),
                dynamic_way_value_conditions=way_value_layers[definition.axis_id].conditions,
                dynamic_way_value_undetermined_by_bearing=way_value_layers[definition.axis_id].undetermined_by_bearing,
                time_scope=definition.time_scope,
            )
            for definition in published_axis_definitions()
        ],
        tile_runtime_scales=tile_runtime_scales(accident_years),
    )
