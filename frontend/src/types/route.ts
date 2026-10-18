import type { components, paths } from "./generated/api";

type Schemas = components["schemas"];
/** 応答が1つのモデルではなく、状態で形の変わる共用体の口は、口の応答の型をそのまま引く。 */
type GetJson<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { "application/json": infer T } } } };
}
  ? T
  : never;

export type Coordinates = Schemas["Coordinates"];

/** 地点（出発地・経由地・目的地）の役割。 */
export type PinRole = "origin" | "waypoint" | "destination";

/** 選んでいる地点。地図のタップはこの地点を置く。経由地の`index`がnullなのは、新しく足す経由地。 */
export type PointTarget = { role: "origin" } | { role: "destination" } | { role: "waypoint"; index: number | null };

/** 位置情報の出所。"manual"は地図のタップで出発地点を置いたもの。 */
export type LocationSource = "geolocation" | "default" | "manual";

export type RouteSegmentDetail = Schemas["RouteSegmentDetail"];

export type RouteCandidate = Schemas["RouteCandidate"];
export type RouteTurn = Schemas["RouteTurn"];
export type RoutePoint = Schemas["RoutePoint"];
/** 住所の検索で当たった地点の候補。 */
export type PlaceCandidate = Schemas["PlaceCandidate"];
export type OverallDifficulty = Schemas["OverallDifficulty"];

/** 地図上で押された区間と、押された地点（マーカーを置く位置）。区間は地図のfeatureのpropertiesから
 * 組み直すので、`segment.geometry`はnull。 */
export interface SelectedRouteSegment {
  segment: RouteSegmentDetail;
  latitude: number;
  longitude: number;
}

export type RouteGenerateRequest = Schemas["RouteGenerateRequest"];
export type RouteGenerateJobStatusResponse = GetJson<"/api/routes/generate/{job_id}">;

export type RoutePreferenceWeights = Schemas["RoutePreferenceWeights"];
export type RoadAvoidanceOverride = Schemas["RoadAvoidanceOverride"];

// 実際に適用された条件のエコー。
export type GenerationConditions = Schemas["GenerationConditions"];

export type AxisCatalogResponse = Schemas["AxisCatalogResponse"];
export type AxisCatalogEntry = Schemas["AxisCatalogEntry"];

// 軸スタジオが使う評価軸定義のCRUD型。/api/admin/axis-definitions。
export type AxisDefinitionPayload = Schemas["AxisDefinitionPayload"];
export type AxisDefinitionResponse = Schemas["AxisDefinitionResponse"];
// 画面は形を組み立てて送る側なので、要求の側の形を引く。
export type AxisShape = AxisDefinitionPayload["shape"];

export type JmaTileIndexResponse = GetJson<"/api/jma-tile-index">;

// 材料ごとの欠損割合。GET /api/admin/material-catalog/coverageの応答。
export type MaterialCoverageResponse = Schemas["MaterialCoverageReport"];
export type MaterialCoverageEntry = MaterialCoverageResponse["materials"][number];

// 派生データの鮮度台帳。GET /api/admin/derived-data/freshnessの応答。
export type DerivedDataFreshnessResponse = Schemas["DerivedDataFreshnessReport"];
export type DbStatusResponse = Schemas["DbStatusReport"];
