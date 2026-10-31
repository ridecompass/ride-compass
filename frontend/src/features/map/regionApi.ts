import type { components, paths } from "@/types/generated/api";
import type { RoutePreferenceWeights } from "@/types/route";
import { apiPath } from "@/lib/apiPath";
import { tileBaseUrl } from "@/lib/tileBaseUrl";
import { backendApi, requestApi } from "@/lib/apiClient";
import regionTileConfig from "@/types/generated/region-tile-config.json";
import { API_TIMEOUT_MS } from "@/lib/apiTimeouts";
import type { PointTileLayer } from "@/lib/mapDisplay/pointLayers";

const ROAD_SURFACE_TILE_PATH = apiPath("/api/region/road-surface-tiles/{z}/{x}/{y}.pbf");

// タイルの世代。**手で上げない**——焼き込むSQLの署名とDBの派生データ・生データの世代からbackendが導き、実行時に配る（軸カタログの
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
 * **軸カタログの到着と同一視しない**。世代を返さない版のbackendが200で応答すると、カタログは「取得済み」なのに
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

// 路面タイル（点のタイルも同じ）を要求するズーム範囲。正はbackendで、生成物で受け取る。
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
export interface AxisInspectorConditions extends RideConditions {
  z: number;
  x: number;
  y: number;
}

export type AxisInspectorResult = components["schemas"]["AxisInspectorResult"];

type RoadAt = components["schemas"]["RoadAt"];

/** 押した所から`radiusM`以内の道（近い順）。プロパティはズーム`z`の路面タイルと同じ。 */
export async function fetchRoadsAt(
  lngLat: readonly [number, number],
  z: number,
  radiusM: number,
): Promise<readonly RoadAt[]> {
  const body = { longitude: lngLat[0], latitude: lngLat[1], z, radius_m: radiusM };
  return requestApi((init) => backendApi.POST("/api/region/roads-at", { body, ...init }), {
    timeoutMs: API_TIMEOUT_MS.default,
    category: "api:roads-at",
    messages: { failure: "道の取得に失敗しました", parseFailure: "道の取得に失敗しました" },
    requestMeta: { body },
    successMeta: (data) => ({ found: data.length }),
  });
}

/** 地図で押した道（`osm_way_id`）の一次属性と、押したフィーチャー（その倍率で地図が塗る区間か道1本）の全軸・合成を取る。 */
export async function fetchAxisInspector(
  osmWayId: number,
  featureKey: string,
  conditions: AxisInspectorConditions,
  routePreference: RoutePreferenceWeights | null,
): Promise<AxisInspectorResult | null> {
  const body = {
    osm_way_id: osmWayId,
    // 合成に使う重み（利用者がいま設定しているもの）。送らなければbackendの既定の重み。
    ...(routePreference != null ? { route_preference: routePreference } : {}),
    // 押した地物の識別子（そのタイルが焼いた区間か道1本）。
    feature_key: featureKey,
    z: conditions.z,
    x: conditions.x,
    y: conditions.y,
    bearing_deg: conditions.bearingDeg,
    at: conditions.at.toISOString(),
    speed_kmh: conditions.speedKmh,
  };
  return requestApi((init) => backendApi.POST("/api/region/axis-inspector", { body, ...init }), {
    timeoutMs: API_TIMEOUT_MS.default,
    category: "api:axis-inspector",
    messages: { failure: "内訳の取得に失敗しました", parseFailure: "内訳の取得に失敗しました" },
    requestMeta: { body },
    successMeta: (data) => ({ composite: data?.values.composite_difficulty }),
  });
}

/** 1枚のタイルの中の道ごとの値。 */
interface TileWayValues<Value> {
  /** feature_key→値。 */
  values: Record<string, Value>;
  /** 通信失敗（HTTPエラー・ネットワークエラー・タイムアウト）ならtrue。backendが正常応答で
   * 空オブジェクトを返した場合（対象範囲に本当に道が無い）はfalseのまま——呼び出し側が
   * 「取得失敗」と「本当に空」を区別できるようにする。 */
  error: boolean;
}

/** 道ごとの値の取得。失敗しても例外にせず`error: true`を返す（道の塗りは補助の機能なので、道路や他のレイヤーを
 * 巻き込んで止めない。失敗したことは利用者へ示せるよう返す）。 */
async function tileWayValues<Value>(request: () => Promise<Record<string, Value>>): Promise<TileWayValues<Value>> {
  try {
    return { values: await request(), error: false };
  } catch {
    // 失敗の内訳は`requestApi`が記録済み。
    return { values: {}, error: true };
  }
}

// 軸の、タイルの中の道ごとの材料。パスは軸idで決まり、軸ごとの関数を持たない。世代のクエリを持たない
// （ブラウザのキャッシュに載せない軽いJSONで、新しさはbackendが持つ）。

/** 道ごとの材料の要求へ載せる走る条件（軸カタログの`dynamic_way_value_material_conditions`の名前だけ）。 */
export type WayMaterialsQuery = NonNullable<
  paths["/api/region/way-materials/{axis_id}/{z}/{x}/{y}"]["get"]["parameters"]["query"]
>;

/** 路面タイルと同じz/x/yの中の道ごとの材料（材料の名前→値。値の無い材料は鍵ごと無い）。`query`は、軸が要求へ
 * 載せると宣言した条件だけを呼ぶ側が渡す。 */
export async function fetchWayMaterials(
  axisId: string,
  z: number,
  x: number,
  y: number,
  query: WayMaterialsQuery,
): Promise<TileWayValues<Record<string, number>>> {
  const params = { path: { axis_id: axisId, z, x, y }, query };
  return tileWayValues(() =>
    requestApi((init) => backendApi.GET("/api/region/way-materials/{axis_id}/{z}/{x}/{y}", { params, ...init }), {
      timeoutMs: API_TIMEOUT_MS.default,
      category: `api:${axisId}-way-materials`,
      messages: {
        failure: "道路の塗りの材料の取得に失敗しました",
        parseFailure: "道路の塗りの材料の解析に失敗しました",
      },
      successMeta: (data) => ({ wayCount: Object.keys(data).length }),
    }),
  );
}

/** 路面タイルと同じz/x/yの中の道ごとの、道の線の層の値（層のid→区分の鍵か「データなし」。区分の外の道の層は無い）。 */
export async function fetchRoadClasses(
  z: number,
  x: number,
  y: number,
): Promise<TileWayValues<Record<string, string>>> {
  return tileWayValues(() =>
    requestApi(
      (init) => backendApi.GET("/api/region/road-classes/{z}/{x}/{y}", { params: { path: { z, x, y } }, ...init }),
      {
        timeoutMs: API_TIMEOUT_MS.default,
        category: "api:road-classes",
        messages: { failure: "道の区分の取得に失敗しました", parseFailure: "道の区分の解析に失敗しました" },
        successMeta: (data) => ({ wayCount: Object.keys(data).length }),
      },
    ),
  );
}
