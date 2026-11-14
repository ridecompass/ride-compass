import type { components, paths } from "@/types/generated/api";
import type { CostPreference } from "@/types/route";
import { apiPath } from "@/lib/apiPath";
import { tileBaseUrl } from "@/lib/tileBaseUrl";
import { backendApi, requestApi } from "@/lib/apiClient";
import regionTileConfig from "@/types/generated/region-tile-config.json";
import type { PointTileLayer } from "@/lib/mapDisplay/pointLayers";

const ROAD_SURFACE_TILE_PATH = apiPath("/api/region/road-surface-tiles/{z}/{x}/{y}.pbf");

// タイルの世代。**手で上げない**——焼き込むSQLの署名とDBの派生データ・生データの世代からbackendが導き、実行時に配る（画面の設定の
// `tile_versions`）。ビルド時の生成物に持たないのは、バッチがタイルを作り直してもデプロイは起きないため。
// 既定値は置かない——届く前にタイルを要求すると、世代の違う中身がブラウザのキャッシュへ載って残る。
// 既存の属性の意味を変える変更だけはデプロイの順序に注意が要る（docs/architecture/tech-stack.md「デプロイの反映確認」）。

/** 配信されるタイルの系統（源泉が配る一覧）。1つでも欠けたら「未取得」。 */
const TILE_KINDS = regionTileConfig.tile_version_kinds;
type TileKind = (typeof TILE_KINDS)[number];

declare const COMPLETE_TILE_VERSIONS: unique symbol;
/** 全系統の世代が揃ったもの。`completeTileVersions`だけが作る（URLを組み立てる側は、揃ったかを確かめ直さない）。 */
export type TileVersions = Readonly<Record<string, string>> & { readonly [COMPLETE_TILE_VERSIONS]: true };

/** 配られた世代から、全系統が揃ったものを取り出す。1つでも欠けたら`null`。
 *
 * **画面の設定の到着と同一視しない**。世代を返さない版のbackendが200で応答すると、カタログは「取得済み」なのに
 * 世代は揃わない——そこでURLを組み立てると例外になる。空の辞書も「揃った」と見なさない。 */
export function completeTileVersions(versions: Readonly<Record<string, string>>): TileVersions | null {
  return TILE_KINDS.every((kind) => Boolean(versions[kind])) ? (versions as TileVersions) : null;
}

function tileVersion(versions: TileVersions, kind: TileKind): string {
  const version = versions[kind];
  if (!version) {
    // 源泉が配る系統の一覧から、URLを組み立てる系統が消えたときだけ起きる（黙って既定値を使うと、世代の違う
    // タイルがキャッシュへ載っても気づけない）。
    throw new Error(`タイル世代の系統に${kind}がありません`);
  }
  return version;
}

// 基礎地図のスタイルJSON。中のタイル・スプライト・グリフのURLはbackendがBASEMAP_PUBLIC_BASE_URLで
// 組み立てるため、`tileBaseUrl()`と同じオリジンを指すよう揃える。
const MAP_STYLE_PATH = apiPath("/api/basemap/{path}", { path: "styles/liberty" });
export function mapStyleUrl(): string {
  return `${tileBaseUrl()}${MAP_STYLE_PATH}`;
}

// ベクタタイルのURL。MapLibreはWeb Workerの中で取るため相対パスでは解決できず、絶対URLが要る。`window`をSSRで
// 読まないよう、呼んだとき（クライアントだけ）に組み立てる。
export function roadSurfaceTileUrl(versions: TileVersions): string {
  return `${tileBaseUrl()}${ROAD_SURFACE_TILE_PATH}?v=${tileVersion(versions, "road_surface")}`;
}

// 点のレイヤーはどれも同じ1つの配信で、パスのレイヤー名だけが違う。停止要因と補給の点は同じタイルを分け合う（種別の集合で分ける）。
export function pointTileUrl(versions: TileVersions, layer: PointTileLayer): string {
  const path = apiPath("/api/region/point-tiles/{layer}/{z}/{x}/{y}.pbf", { layer });
  return `${tileBaseUrl()}${path}?v=${tileVersion(versions, layer)}`;
}

// 土地被覆のラスタタイル。世代はbackendが生成物で配る。オリジンの決め方は他のタイルと揃える。
const LANDCOVER_TILE_PATH = apiPath("/api/region/landcover-tiles/{z}/{x}/{y}.png");
const LANDCOVER_TILE_VERSION = regionTileConfig.landcover.tile_version;

export function landcoverTileUrl(): string {
  return `${tileBaseUrl()}${LANDCOVER_TILE_PATH}?v=${LANDCOVER_TILE_VERSION}`;
}

// 道のタイルを要求するズーム範囲。正はbackendで、生成物で受け取る。点のタイルと道ごとの値（レンズ・押した所の道）は
// `ROAD_TILE_MIN_ZOOM`から、路面タイル（道の線）だけは道ごとの鍵を持たずに`ROAD_SURFACE_TILE_MIN_ZOOM`から。
export const ROAD_SURFACE_TILE_MIN_ZOOM = regionTileConfig.road_surface_tile_min_zoom;
export const ROAD_TILE_MIN_ZOOM = regionTileConfig.road_tile_min_zoom;
export const ROAD_TILE_MAX_ZOOM = regionTileConfig.road_tile_max_zoom;

/** 地図が今指定している走行の条件。専用way値配信軸（風・勾配）が地図を塗るのに使うものと
 * 同じ値で、これを送らないと**1本の道が往復2方向で違う値を持つ**軸を算出できない。 */
export interface RideConditions {
  bearingDeg: number;
  at: Date;
  speedKmh: number;
}

/** 上記に、クリックされた点を含む道路タイルを足したもの（レンズが引いたのと同じタイルを
 * 指すため、backendは同じキャッシュから値を引ける）。 */
export interface RoadInspectorConditions extends RideConditions {
  z: number;
  x: number;
  y: number;
}

export type RoadInspection = components["schemas"]["RoadInspection"];

type RoadAt = components["schemas"]["RoadAt"];

/** 押した所から`radiusM`以内の道（近い順）。プロパティはズーム`z`の路面タイルと同じ。 */
export async function fetchRoadsAt(
  lngLat: readonly [number, number],
  z: number,
  radiusM: number,
): Promise<readonly RoadAt[]> {
  const body = { longitude: lngLat[0], latitude: lngLat[1], z, radius_m: radiusM };
  return requestApi((init) => backendApi.POST("/api/region/roads-at", { body, ...init }), {
    category: "api:roads-at",
    messages: { failure: "道の取得に失敗しました", parseFailure: "道の取得に失敗しました" },
    requestMeta: { body },
    successMeta: (data) => ({ found: data.length }),
  });
}

/** 地図で押した道（`osm_way_id`）の一次属性と、押したフィーチャー（その倍率で地図が塗る区間か道1本）のレンズの値を取る。 */
export async function fetchRoadInspection(
  osmWayId: number,
  featureKey: string,
  conditions: RoadInspectorConditions,
  costPreference: CostPreference,
): Promise<RoadInspection | null> {
  const body = {
    osm_way_id: osmWayId,
    // 費用のレンズの値を求める利用者の値（地図のレンズ・ルート生成と同じもの）。
    cost_preference: costPreference,
    // 押した地物の識別子（そのタイルが焼いた区間か道1本）。
    feature_key: featureKey,
    z: conditions.z,
    x: conditions.x,
    y: conditions.y,
    bearing_deg: conditions.bearingDeg,
    at: conditions.at.toISOString(),
    speed_kmh: conditions.speedKmh,
  };
  return requestApi((init) => backendApi.POST("/api/region/road-inspector", { body, ...init }), {
    category: "api:road-inspector",
    messages: { failure: "道の窓の取得に失敗しました", parseFailure: "道の窓の取得に失敗しました" },
    requestMeta: { body },
    successMeta: (data) => ({ found: data !== null }),
  });
}

/** 費用の軸のレンズの道ごとの材料の要求の条件（想定速度は要る。`/api/cost-axes`の`map_lens.material_conditions`）。 */
export type LensMaterialsQuery = paths["/api/region/lens/{lens_id}/{z}/{x}/{y}"]["get"]["parameters"]["query"];

/** 路面タイルと同じz/x/yの中の道ごとの、レンズ`lensId`（総合か費用の軸）の材料（道の向き・逆向きに辿った1kmあたりの
 * 代償の秒と道の向き。値の無い材料は鍵ごと無い）。 */
export async function fetchLensMaterials(
  lensId: string,
  z: number,
  x: number,
  y: number,
  query: LensMaterialsQuery,
): Promise<Record<string, Record<string, number>>> {
  const params = { path: { lens_id: lensId, z, x, y }, query };
  return requestApi((init) => backendApi.GET("/api/region/lens/{lens_id}/{z}/{x}/{y}", { params, ...init }), {
    category: `api:${lensId}-lens`,
    messages: {
      failure: "道路の塗りの値の取得に失敗しました",
      parseFailure: "道路の塗りの値の解析に失敗しました",
    },
    successMeta: (data) => ({ wayCount: Object.keys(data).length }),
  });
}
