/** 画面の設定（`GET /api/client-config`）と費用の軸の一覧（`GET /api/cost-axes`）のうち、地図だけが読むものを導く。 */
import type { MapLens } from "@/lib/mapDisplay/mapLens";
import type { RouteStyleMode } from "@/lib/mapDisplay/routeStyleModes";
import { completeTileVersions, type TileVersions } from "@/features/map/regionApi";
import { buildMapLayers, type MapLayerDescriptor } from "@/features/map/layers/mapLayers";
import type { ClientConfigResponse, RoadMapLayerView } from "@/types/route";
import type { MapTheme } from "@/lib/mapTheme";

export interface MapCatalog {
  /** 道を1kmあたりの代償の秒で塗るレンズ（総合と費用の軸ごと。`features/map/costLens.ts: costLenses`）。費用の軸の一覧が
   * 届くまでは空。 */
  lenses: readonly MapLens[];
  /** ルート地図の色分けモード一覧（同じレンズのもの）。費用の軸の一覧が届くまでは空。 */
  routeStyleModes: readonly RouteStyleMode[];
  /** 事故データの収録年（backendの取込の宣言そのもの）。地図の説明文が範囲を書くのに使う。
   * 取得完了まで・エラー時は空で、その間は説明文が年に触れない。 */
  accidentYears: readonly number[];
  /** フロントが使う較正値（応答の`client_tuning`）。地図の説明文が数を差し込む。取得できるまでは空。 */
  clientTuning: Readonly<Record<string, number>>;
  /** 道の線の層（公開した分け方1つが層1つ）。地図の線・チップ・凡例・帯がこの並びから作る。取得できるまでは空。 */
  roadLayers: readonly RoadMapLayerView[];
  /** タイルの世代。全系統が揃うまで`null`で、その間は地図がタイルのソースを作らない。 */
  tileVersions: TileVersions | null;
  /** 地図に載るものの一覧。上のレンズと収録年から1回だけ組む。 */
  layers: readonly MapLayerDescriptor[];
}

/** 画面の設定のうち地図が読むもの（`theme`は塗る地図の地の明るさ。道の区分の色はこの地の上の色へ解いて持つ）。 */
export type MapConfig = Pick<MapCatalog, "accidentYears" | "clientTuning" | "roadLayers" | "tileVersions">;

// 取得できるまではどれも無い状態（ビルド時の写しで埋めない）。
export const EMPTY_MAP_CONFIG: MapConfig = { accidentYears: [], clientTuning: {}, roadLayers: [], tileVersions: null };

export function mapConfigFromResponse(response: ClientConfigResponse, theme: MapTheme = "light"): MapConfig {
  return {
    accidentYears: response.accident_years,
    clientTuning: response.client_tuning,
    roadLayers:
      theme === "dark"
        ? response.road_classes.map_layers.map((layer) => ({
            ...layer,
            classes: layer.classes.map((roadClass) => ({ ...roadClass, color: roadClass.color_on_dark })),
          }))
        : response.road_classes.map_layers,
    tileVersions: completeTileVersions(response.tile_versions),
  };
}

/** 画面の設定のうち地図が読むものと、レンズ・ルートの線のモードから、地図の一覧を組む。 */
export function mapCatalogOf(
  config: MapConfig,
  lenses: readonly MapLens[],
  routeStyleModes: readonly RouteStyleMode[],
): MapCatalog {
  return { ...config, lenses, routeStyleModes, layers: buildMapLayers({ ...config, lenses }) };
}
