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
/** 住所の検索で当たった地点の候補。 */
export type PlaceCandidate = Schemas["PlaceCandidate"];
export type PenaltyBreakdown = Schemas["PenaltyBreakdown"];
/** 費用の軸1つの損の元になった事実（名前と単位つき。ルートの事実と道の窓の事実が同じ形）。 */
export type AxisFact = Schemas["AxisFact"];

/** 地図に番号の点で出す、地点の検索で探した候補と、選んでいる候補の番号（`candidates`の添字）。 */
export interface CandidatesOnMap {
  candidates: readonly PlaceCandidate[];
  picked: number;
}

/** 地図上で押された区間と、押された地点（マーカーを置く位置）。区間は地図のfeatureのpropertiesから
 * 組み直すので、`segment.geometry`はnull。 */
export interface SelectedRouteSegment {
  segment: RouteSegmentDetail;
  latitude: number;
  longitude: number;
}

export type RouteGenerateRequest = Schemas["RouteGenerateRequest"];
export type RouteGenerateJobStatusResponse = GetJson<"/api/routes/generate/{job_id}">;

export type RoadAvoidanceOverride = Schemas["RoadAvoidanceOverride"];
/** 代償の全体に掛けるつまみと、費用の軸ごとの倍率。 */
export type CostPreference = Schemas["CostPreference-Output"];

// 実際に適用された条件のエコー。
export type GenerationConditions = Schemas["GenerationConditions"];

export type ClientConfigResponse = Schemas["ClientConfigResponse"];
export type CostAxisCatalogResponse = Schemas["CostAxisCatalogResponse"];
/** 道の区分。正本は管理DBで、画面の設定（`/api/client-config`）が公開した分け方を解決した形で配る。 */
export type RoadClassCatalog = Schemas["RoadClassCatalog"];
export type RoadMapLayerView = Schemas["RoadMapLayerView"];
export type RoadClassView = Schemas["RoadClassView"];
export type RoadAvoidanceView = Schemas["RoadAvoidanceView"];

export type JmaTileIndexResponse = GetJson<"/api/jma-tile-index">;

// 材料ごとの欠損割合。GET /api/admin/material-catalog/coverageの応答。
export type MaterialCoverageResponse = Schemas["MaterialCoverageReport"];
export type MaterialCoverageEntry = MaterialCoverageResponse["materials"][number];

// 派生データの鮮度台帳。GET /api/admin/derived-data/freshnessの応答。
export type DerivedDataFreshnessResponse = Schemas["DerivedDataFreshnessReport"];
export type DbStatusResponse = Schemas["DbStatusReport"];
