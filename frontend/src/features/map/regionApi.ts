import type { components, paths } from "@/types/generated/api";
import type { CostPreference } from "@/types/route";
import { apiPath } from "@/lib/apiPath";
import { tileBaseUrl } from "@/lib/tileBaseUrl";
import { backendApi, requestApi } from "@/lib/apiClient";
import regionTileConfig from "@/types/generated/region-tile-config.json";
import type { PointTileLayer } from "@/lib/mapDisplay/pointLayers";

const ROAD_SURFACE_TILE_PATH = apiPath("/api/region/road-surface-tiles/{z}/{x}/{y}.pbf");

// ベクタタイルのURL。MapLibreはWeb Workerの中で取るため相対パスでは解決できず、絶対URLが要る。`window`をSSRで
// 読まないよう、呼んだとき（クライアントだけ）に組み立てる。
// 出発の時刻を含む路面タイルのコマの印`frame`（`useTimeFrames`）を渡すと、時刻で変わる交通規制の道は、そのコマに効く規制で
// 焼いたタイルになる（コマごとに別のURLで、コマが変わったときだけタイルを引き直す）。
export function roadSurfaceTileUrl(frame?: string | null): string {
  const query = frame ? `?frame=${encodeURIComponent(frame)}` : "";
  return `${tileBaseUrl()}${ROAD_SURFACE_TILE_PATH}${query}`;
}

// 点のレイヤーはどれも同じ1つの配信で、パスのレイヤー名だけが違う。停止要因と補給の点は同じタイルを分け合う（種別の集合で分ける）。
export function pointTileUrl(layer: PointTileLayer): string {
  return `${tileBaseUrl()}${apiPath("/api/region/point-tiles/{layer}/{z}/{x}/{y}.pbf", { layer })}`;
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
/** 路面タイルが細い道まで全部描く、いちばん引いたズーム。 */
export const ROAD_SURFACE_ALL_WAYS_MIN_ZOOM = regionTileConfig.road_surface_all_ways_min_zoom;
export const ROAD_TILE_MIN_ZOOM = regionTileConfig.road_tile_min_zoom;
export const ROAD_TILE_MAX_ZOOM = regionTileConfig.road_tile_max_zoom;

/** 地図が今指定している走行の条件。風・勾配のレンズが地図を塗るのに使うものと同じ値で、
 * これを送らないと**1本の道が往復2方向で違う値を持つ**軸を算出できない。時刻は、出発の時刻を含むレンズのコマの印
 * （`useTimeFrames`。一覧がまだ届いていなければundefined、その時刻のコマが無ければnull）。 */
export interface RideConditions {
  /** 走行中の進む向き。走っていなければnull（ルートの前はどちら向きに走るか決まらない）。 */
  bearingDeg: number | null;
  lensFrame: string | null | undefined;
  speedKmh: number;
  /** 地図が道を塗っているレンズ（塗っていなければnull）。道の窓は、このレンズの塗り方で向きを出す。 */
  paintedLensId: string | null;
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
    ...(conditions.bearingDeg !== null ? { bearing_deg: conditions.bearingDeg } : {}),
    ...(conditions.paintedLensId !== null ? { lens_id: conditions.paintedLensId } : {}),
    ...(conditions.lensFrame ? { frame: conditions.lensFrame } : {}),
    // 出発時刻の風のコマが無ければ（予報の範囲の外・予報を読めない）、今の風で求めずに風に依らない難所だけを取る。
    wind: conditions.lensFrame !== null,
    speed_kmh: conditions.speedKmh,
  };
  return requestApi((init) => backendApi.POST("/api/region/road-inspector", { body, ...init }), {
    category: "api:road-inspector",
    messages: { failure: "道の窓の取得に失敗しました", parseFailure: "道の窓の取得に失敗しました" },
    requestMeta: { body },
    successMeta: (data) => ({ found: data !== null }),
  });
}

export type TimeFrames = components["schemas"]["TimeFrames"];
export type TimeFrame = components["schemas"]["TimeFrame"];

/** 時刻で変わる値の、選べる出発時刻の範囲のコマの一覧。 */
export async function fetchTimeFrames(): Promise<TimeFrames> {
  return requestApi((init) => backendApi.GET("/api/region/time-frames", init), {
    category: "api:time-frames",
    messages: { failure: "時刻のコマの取得に失敗しました", parseFailure: "時刻のコマの解析に失敗しました" },
    successMeta: (data) => ({ roadSurface: data.road_surface.length, lens: data.lens.length }),
  });
}

/** 費用の軸のレンズの道ごとの材料の要求の条件（`/api/cost-axes`のレンズごとの`map_lens.material_conditions`）。 */
export type LensMaterialsQuery = paths["/api/region/lens/{lens_id}/{z}/{x}/{y}"]["get"]["parameters"]["query"];

/** 路面タイルと同じz/x/yの中の道ごとの、レンズ`lensId`（総合か費用の軸）の材料（道の向き・逆向きに辿った1kmあたりの
 * 代償の秒と道の向き。値の無い材料は鍵ごと無い）と、その値が前に出た予報の風を引いた素性。 */
export async function fetchLensMaterials(
  lensId: string,
  z: number,
  x: number,
  y: number,
  query: LensMaterialsQuery,
): Promise<components["schemas"]["LensMaterials"]> {
  const params = { path: { lens_id: lensId, z, x, y }, query };
  return requestApi((init) => backendApi.GET("/api/region/lens/{lens_id}/{z}/{x}/{y}", { params, ...init }), {
    category: `api:${lensId}-lens`,
    messages: {
      failure: "道路の塗りの値の取得に失敗しました",
      parseFailure: "道路の塗りの値の解析に失敗しました",
    },
    successMeta: (data) => ({ wayCount: Object.keys(data.materials).length }),
  });
}
