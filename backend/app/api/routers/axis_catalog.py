"""軸カタログの公開読み取りAPI。

一般向けのルート設定画面が、評価軸の一覧
（label/description/category/default_weight）を取得するための読み取り専用・認可不要の
エンドポイント。軸は`AXIS_DEFINITIONS`（プロセス内）から読むので、管理APIで書いた軸も再デプロイなしにここへ出る。
ビルド時の生成物は軸を持たないため、軸を配るのはこのAPIだけ。

**公開済み軸のみを返す**: `is_published=False`（下書き）の軸は
一般ユーザーの目に触れさせない（下書き軸が一般UIに漏れると、まだ検証・命名が
固まっていない軸を一般ユーザーが選んでしまい、その後の破壊的変更・削除ができなく
なる——公開の意味が失われる）。下書き軸の一覧は認可必須の`GET /api/admin/axis-definitions`が返す。

**`map_paint`フィールド**: 軸ごとに求めて含めるので、公開の切替が地図の塗りへ**再デプロイなしに即座に**反映される。
"""

from fastapi import APIRouter, Depends

from app.api.dependencies import get_region_service
from app.domain.axis_definitions import (
    AXIS_DEFINITIONS,
    AxisCategory,
    TimeScope,
    primary_attribute_ids_for,
    published_axis_definitions,
    road_layer_ids_for,
)
from app.domain.axis_raw_value import (
    AxisMaterialBreakdownEntry,
    RawValueUnits,
    axis_material_breakdown,
    raw_value_units,
)
from app.domain.dynamic_way_values import WayValueConditionName
from app.domain.map_paint import MapPaint, map_paint
from app.domain.road_class_catalog import RoadClassCatalog, road_class_catalog
from app.domain.road_classes import current_road_classes
from app.domain.tuning import client_tuning_values
from app.domain.way_value_formula import WayValueFormula
from app.services.dedicated_way_values import dedicated_way_value_layers
from app.services.region_service import RegionService
from app.domain.strict_model import StrictModel

router = APIRouter()


class AxisCatalogEntry(StrictModel):
    axis_id: str
    label: str
    description: str
    category: AxisCategory
    default_weight: float
    # 未設定なら、アイコンの選び方は受け取る側に任せる。
    icon_id: str | None
    # この軸が参照する材料を、対応する一次属性id（domain/registry.py:
    # PrimaryAttributeSpec.attr_id。ビルド時の生成物が配る一次属性と同じ名前空間）へ
    # 解決したもの（重複除去、対応が無い材料[動的気象・未登録一次属性]・他の軸を参照する
    # 材料[階層構造]は除く）。軸と一次属性レイヤーの対応を、軸idで分岐せずに引けるよう
    # 軸スタジオの公開軸にも同じ形で配る。
    primary_attribute_ids: list[str]
    # この軸の材料を区分の決め手に読む、地図の道の線の層（`domain/axis_definitions.py: road_layer_ids_for`。
    # `road_classes`の`map_layers`の`id`）。
    road_layer_ids: list[str]
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
    # この軸の値に効く条件の名前（`services/dedicated_way_values.py: DedicatedWayValueLayer`。
    # 軸の葉の材料を配るサービスが受け取る条件の型から導く）。条件の要らない軸は空。受け取る側が「どの軸が
    # 時刻・向き・想定速度で変わるか」を、axis_idで分岐せずここから決めるために配る。
    dynamic_way_value_conditions: list[WayValueConditionName]
    # `dynamic_way_value_conditions`のうち、道ごとの材料（`GET /api/region/way-materials/{axis_id}`）の要求へ
    # 載せる名前（`services/dedicated_way_values.py: DedicatedWayValueLayer`）。ほかは`way_value_formula`が読む。
    # 載せない名前は応答に効かないので、受け取る側はこの名前の値が変わったときだけ取り直せばよい。
    dynamic_way_value_material_conditions: list[WayValueConditionName]
    # 走行方位しだいで値の決まらない道（木の`undetermined`が真になる道）がありうるか
    # （`services/dedicated_way_values.py: DedicatedWayValueLayer`）。trueの軸だけ、
    # 地図の凡例が「向きで決まらない」の行を持つ（返さない軸に出すと、どの道も入らない行になる）。
    dynamic_way_value_undetermined_by_bearing: bool
    # 地図がこの軸について塗る値を、道ごとの材料（`GET /api/region/way-materials/{axis_id}`）と、
    # `dynamic_way_value_material_conditions`に無い要求の条件から求める式の木（`services/dedicated_way_values.py: DedicatedWayValueLayer`）。
    # 値は区間インスペクタの得点と同じ評価になる。木にできない軸はnullで、ルートの無い間の周りの道を塗れない。
    way_value_formula: WayValueFormula | None
    # 重みが効く時間帯（`domain/axis_definitions.py: AxisDefinition`の`time_scope`）。"always"以外の軸は、
    # その時間帯に通る区間でだけ効く。周りの道は通過する時刻を持たないので、受け取る側が地図の色の前提を
    # axis_idで分岐せずここから決めるために配る。
    time_scope: TimeScope


class AxisCatalogResponse(StrictModel):
    axes: list[AxisCatalogEntry]
    # フロントが使う較正値（id → いま効いている値、`domain/tuning.py`が宣言。作り直しで効く値は作り直しに使った値）。管理画面から
    # 変えた値を**再デプロイなしに**画面へ届けるため、起動時に1回取るこのカタログへ相乗り
    # させる（ビルド時生成物のroute-generate-config.jsonが持つ既定値は、画面がidの型にだけ使い、値は読まない）。
    client_tuning: dict[str, float]
    # 配信するタイルの世代（系統名 → `<派生の世代>.<生データの世代>-<形の署名>`、`services/
    # tile_version_service.py`）。フロントはこれをタイルURLのクエリへ入れてブラウザの
    # キャッシュを分ける。**ビルド時生成物では配れない**——バッチが中身を作り直しても
    # デプロイは起きないため、次のデプロイまで古い値を配り続ける。
    tile_versions: dict[str, str]
    # 事故データの収録年（今の事故の数を数えた取込の宣言そのもの）。地図の説明文が範囲を書くために
    # 使う。**表示側に持たせない**——文字列で持つと取り込み直したときに黙って食い違う。
    accident_years: list[int]
    # 道の区分（`domain/road_class_catalog.py: road_class_catalog`）。管理APIで書いた区分を再デプロイなしに届ける。
    road_classes: RoadClassCatalog


@router.get("/api/axis-catalog", response_model=AxisCatalogResponse)
async def get_axis_catalog(region_service: RegionService = Depends(get_region_service)) -> AxisCatalogResponse:
    # 軸はプロセス内の値をそのまま返す。事故の収録年・作り直しで効く較正値・タイルの世代だけがDBを見る。
    accident_years = await region_service.get_accident_years()
    rebuilt_tuning = await region_service.get_rebuilt_client_tuning()
    tile_versions = await region_service.tile_versions()
    way_value_layers = dedicated_way_value_layers()
    road_classes = current_road_classes()

    return AxisCatalogResponse(
        client_tuning={**client_tuning_values(), **rebuilt_tuning},
        accident_years=accident_years,
        tile_versions=tile_versions,
        road_classes=road_class_catalog(road_classes),
        axes=[
            AxisCatalogEntry(
                axis_id=definition.axis_id,
                label=definition.label,
                description=definition.description,
                category=definition.category,
                default_weight=definition.default_weight,
                icon_id=definition.icon_id,
                primary_attribute_ids=primary_attribute_ids_for(definition),
                road_layer_ids=road_layer_ids_for(definition, road_classes),
                map_paint=map_paint(definition),
                raw_value_units=raw_value_units(definition),
                material_breakdown=axis_material_breakdown(definition, AXIS_DEFINITIONS),
                dynamic_way_value_conditions=way_value_layers[definition.axis_id].conditions,
                dynamic_way_value_material_conditions=way_value_layers[definition.axis_id].material_conditions,
                dynamic_way_value_undetermined_by_bearing=way_value_layers[definition.axis_id].undetermined_by_bearing,
                way_value_formula=way_value_layers[definition.axis_id].formula,
                time_scope=definition.time_scope,
            )
            for definition in published_axis_definitions()
        ],
    )
